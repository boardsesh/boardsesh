import 'server-only';
import { createHash, hkdfSync } from 'node:crypto';
import { encode, decode } from 'next-auth/jwt';
import { z } from 'zod';
import { anonymousProviderPreparationSchema } from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { readBrowserCorrelationCookie } from './browser-proof-cookies.server';
import type { PresentedBrowserSelection } from './presented-browser-selection.server';

const purpose = 'boardsesh-anonymous-provider-flow-v1';
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
export const anonymousProviderFlowSchema = z
  .object({
    version: z.literal(1),
    provider: z.enum(['google', 'apple']),
    credentialKind: z.enum(['legacy-jwe', 'canonical-token']),
    browserBindingHash: digest,
    browserVersion: z.number().int().nonnegative().max(2_147_483_646),
    browserBindingExpiresAt: timestamp,
    intentToken: token,
    browserIntentToken: token,
    flowHash: digest,
    nonce: z.string().min(1).max(1024).nullable(),
    returnUrl: z.url(),
    issuedAt: timestamp,
    expiresAt: timestamp,
    preparationToken: token.nullable(),
    preparation: anonymousProviderPreparationSchema.nullable(),
  })
  .strict();
export type AnonymousProviderFlow = z.infer<typeof anonymousProviderFlowSchema>;
export interface AnonymousProviderBrowserContext {
  readonly browser: Readonly<{ bindingToken: string; expectedVersion: number }>;
  readonly cursor: Readonly<{ bindingId: string; version: number; bindingExpiresAt: string }>;
}
const refuse = (): never => {
  throw new AuthBackendUnavailableError();
};
function key(secret: string): string {
  if (!secret || secret.trim() !== secret || Buffer.byteLength(secret) < 32) return refuse();
  return Buffer.from(hkdfSync('sha256', secret, purpose, 'boardsesh-anonymous-provider-cookie', 32)).toString(
    'base64url',
  );
}
export function assertAnonymousProviderFlowSecret(secret: string): void {
  key(secret);
}

/** Actual primary anonymous read plus the exact actual correlation cookie.
 * Missing or refused selection never becomes an anonymous signing context. */
export function captureAnonymousProviderBrowserContext(
  cookieHeader: string | null,
  selection: PresentedBrowserSelection,
): AnonymousProviderBrowserContext {
  const correlation = readBrowserCorrelationCookie(cookieHeader);
  if (
    selection.status !== 'anonymous' ||
    correlation.status !== 'present' ||
    correlation.bindingId !== selection.cursor.bindingId ||
    !Number.isSafeInteger(selection.cursor.version) ||
    selection.cursor.version < 0 ||
    selection.cursor.version >= 2_147_483_647 ||
    !Number.isFinite(Date.parse(selection.cursor.bindingExpiresAt)) ||
    Date.parse(selection.cursor.bindingExpiresAt) <= Date.now()
  )
    return refuse();
  return Object.freeze({
    browser: Object.freeze({ bindingToken: correlation.token, expectedVersion: selection.cursor.version }),
    cursor: Object.freeze({ ...selection.cursor }),
  });
}
export function requireAnonymousProviderBrowser(
  flow: AnonymousProviderFlow,
  current: AnonymousProviderBrowserContext,
): void {
  if (
    flow.browserBindingHash !== current.cursor.bindingId ||
    flow.browserVersion !== current.browser.expectedVersion ||
    flow.browserVersion !== current.cursor.version ||
    flow.browserBindingExpiresAt !== current.cursor.bindingExpiresAt ||
    createHash('sha256').update(current.browser.bindingToken).digest('hex') !== flow.browserBindingHash
  )
    return refuse();
}
function capture(input: unknown, now: Date): AnonymousProviderFlow {
  const flow = anonymousProviderFlowSchema.parse(input);
  const clock = now.getTime();
  const issued = Date.parse(flow.issuedAt);
  const expiry = Date.parse(flow.expiresAt);
  if (
    !Number.isSafeInteger(clock) ||
    clock <= 0 ||
    issued > clock ||
    expiry <= clock ||
    expiry <= issued ||
    expiry > issued + 900_000 ||
    expiry > Date.parse(flow.browserBindingExpiresAt) ||
    (flow.preparationToken === null) !== (flow.preparation === null) ||
    (flow.provider === 'google' ? flow.nonce === null : flow.nonce !== null)
  )
    return refuse();
  const destination = new URL(flow.returnUrl);
  if (destination.protocol !== 'https:' || destination.username || destination.password || destination.hash)
    return refuse();
  if (flow.preparation) {
    const target = flow.preparation;
    const proof = target.credentialProof;
    if (
      target.identityPlan.provider !== flow.provider ||
      target.credentialKind !== flow.credentialKind ||
      proof.userId !== target.identityPlan.user.id ||
      proof.generation !== target.identityPlan.generation ||
      proof.requiresAccountCutoff ||
      target.identityPlan.subject !== target.verifiedIdentity.sub ||
      Date.parse(target.expiresAt) > expiry ||
      Date.parse(target.expiresAt) <= clock ||
      Date.parse(target.expiresAt) > Date.parse(target.credentialExpiresAt) ||
      Date.parse(target.credentialExpiresAt) > Date.parse(flow.browserBindingExpiresAt) ||
      (target.proposedCanonicalTokenHash !== null) !== (flow.credentialKind === 'canonical-token') ||
      (proof.authenticatedAt === null ? proof.linkGuarded : !proof.linkGuarded) ||
      (flow.provider === 'apple' && (proof.authenticatedAt !== null || proof.linkGuarded))
    )
      return refuse();
  }
  return Object.freeze({
    ...flow,
    preparation:
      flow.preparation === null
        ? null
        : Object.freeze({
            ...flow.preparation,
            identityPlan: Object.freeze({
              ...flow.preparation.identityPlan,
              user: Object.freeze({ ...flow.preparation.identityPlan.user }),
            }),
            verifiedIdentity: Object.freeze({ ...flow.preparation.verifiedIdentity }),
            credentialProof: Object.freeze({ ...flow.preparation.credentialProof }),
          }),
  });
}
export function anonymousProviderFlowCookieName(flowHash: string): string {
  return `__Host-boardsesh.anonymous-provider.${digest.parse(flowHash)}`;
}
export function anonymousProviderPendingCookieName(flowHash: string): string {
  return `__Host-boardsesh.anonymous-provider-pending.${digest.parse(flowHash)}`;
}
export async function sealAnonymousProviderFlow(input: unknown, secret: string): Promise<string> {
  try {
    const flow = capture(input, new Date());
    const remaining = Math.floor((Date.parse(flow.expiresAt) - Date.now()) / 1000) - 1;
    if (remaining <= 0) return refuse();
    const sealed = await encode({ secret: key(secret), maxAge: remaining, token: { purpose, flow } });
    if (!sealed || Buffer.byteLength(sealed) > 3800) return refuse();
    await openAnonymousProviderFlow(sealed, flow.flowHash, secret);
    return sealed;
  } catch {
    return refuse();
  }
}
export async function openAnonymousProviderFlow(
  sealed: string,
  flowHash: string,
  secret: string,
): Promise<AnonymousProviderFlow> {
  try {
    if (!sealed || Buffer.byteLength(sealed) > 3800) return refuse();
    const payload = z
      .object({
        purpose: z.literal(purpose),
        flow: anonymousProviderFlowSchema,
        iat: z.number().int(),
        exp: z.number().int(),
        jti: z.uuid(),
      })
      .strict()
      .parse(await decode({ secret: key(secret), token: sealed }));
    const flow = capture(payload.flow, new Date());
    if (
      flow.flowHash !== digest.parse(flowHash) ||
      !Number.isSafeInteger(payload.exp * 1000) ||
      payload.exp * 1000 <= Date.now() ||
      payload.exp * 1000 > Date.parse(flow.expiresAt)
    )
      return refuse();
    return flow;
  } catch {
    return refuse();
  }
}
