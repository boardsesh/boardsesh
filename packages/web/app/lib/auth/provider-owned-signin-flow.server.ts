import 'server-only';
import { createHash, hkdfSync } from 'node:crypto';
import { encode, decode } from 'next-auth/jwt';
import { z } from 'zod';
import { providerOwnedSigninPreparationSchema } from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { providerSecurityFlowSchema } from './provider-security-flow.server';
import { requireProviderSecurityFlowActor, type ProviderBrowserContext } from './provider-security-selection.server';

const purpose = 'boardsesh-provider-owned-signin-flow-v1';
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const limit = 3800;
const sourceFields = providerSecurityFlowSchema.pick({
  actorKind: true,
  actorCredentialHash: true,
  browserBindingHash: true,
  browserVersion: true,
  browserBindingExpiresAt: true,
  sourceCredentialProof: true,
  credentialExpiresAt: true,
  issuedAt: true,
  expiresAt: true,
});
/** Distinct login intent, never provider link/reauthentication evidence. Raw
 * source and candidate credentials remain solely in the actual proof cookies. */
export const providerOwnedSigninFlowSchema = sourceFields
  .extend({
    version: z.literal(1),
    provider: z.enum(['google', 'apple']),
    intentToken: token,
    browserIntentToken: token,
    flowHash: digest,
    nonce: z.string().min(1).max(1024).nullable(),
    returnUrl: z.url(),
    preparationToken: token.nullable(),
    preparation: providerOwnedSigninPreparationSchema.nullable(),
  })
  .strict();
export type ProviderOwnedSigninFlow = z.infer<typeof providerOwnedSigninFlowSchema>;

const refuse = (): never => {
  throw new AuthBackendUnavailableError();
};
function milliseconds(iso: string): number {
  const parsed = Date.parse(iso);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return refuse();
  return parsed;
}
function key(secret: string): string {
  if (!secret || secret !== secret.trim() || Buffer.byteLength(secret) < 32) return refuse();
  // Use the installed public JWE codec with a fixed purpose-derived key. A
  // NextAuth credential or provider-operation carrier cannot cross this domain.
  return Buffer.from(hkdfSync('sha256', secret, purpose, 'boardsesh-owned-provider-signin-cookie', 32)).toString(
    'base64url',
  );
}
export function assertProviderOwnedSigninFlowSecret(secret: string): void {
  key(secret);
}
function capture(input: unknown, now: Date): ProviderOwnedSigninFlow {
  const flow = providerOwnedSigninFlowSchema.parse(input);
  const clock = now.getTime();
  const issued = milliseconds(flow.issuedAt);
  const expiry = milliseconds(flow.expiresAt);
  if (
    !Number.isSafeInteger(clock) ||
    clock <= 0 ||
    issued > clock ||
    expiry <= clock ||
    expiry <= issued ||
    expiry > issued + 900_000 ||
    expiry > milliseconds(flow.credentialExpiresAt) ||
    expiry > milliseconds(flow.browserBindingExpiresAt) ||
    (flow.preparation === null) !== (flow.preparationToken === null)
  )
    return refuse();
  if (
    flow.sourceCredentialProof.authenticatedAt === null
      ? flow.sourceCredentialProof.linkGuarded
      : milliseconds(flow.sourceCredentialProof.authenticatedAt) > issued
  )
    return refuse();
  const destination = new URL(flow.returnUrl);
  if (destination.protocol !== 'https:' || destination.username || destination.password || destination.hash)
    return refuse();
  if (flow.preparation) {
    const prepared = flow.preparation;
    if (
      prepared.provider !== flow.provider ||
      prepared.credentialProof.userId === flow.sourceCredentialProof.userId ||
      prepared.credentialProof.authSessionId === flow.sourceCredentialProof.authSessionId ||
      milliseconds(prepared.expiresAt) > expiry ||
      milliseconds(prepared.expiresAt) <= clock ||
      milliseconds(prepared.credentialExpiresAt) > milliseconds(flow.browserBindingExpiresAt) ||
      milliseconds(prepared.credentialExpiresAt) <= clock ||
      milliseconds(prepared.expiresAt) > milliseconds(prepared.credentialExpiresAt) ||
      (prepared.proposedCanonicalTokenHash !== null) !== (flow.actorKind === 'canonical-token') ||
      (prepared.provider === 'apple' &&
        (prepared.credentialProof.authenticatedAt !== null || prepared.credentialProof.linkGuarded))
    )
      return refuse();
  }
  return Object.freeze({
    ...flow,
    sourceCredentialProof: Object.freeze(flow.sourceCredentialProof),
    preparation:
      flow.preparation === null
        ? null
        : Object.freeze({ ...flow.preparation, credentialProof: Object.freeze(flow.preparation.credentialProof) }),
  });
}
export function providerOwnedSigninCookieName(flowHash: string): string {
  return `__Host-boardsesh.provider-signin.${digest.parse(flowHash)}`;
}
export function providerOwnedSigninPendingCookieName(flowHash: string): string {
  return `__Host-boardsesh.provider-signin-pending.${digest.parse(flowHash)}`;
}
export function providerOwnedSigninNonceHash(nonce: string | null): string | null {
  return nonce === null ? null : createHash('sha256').update(z.string().min(1).max(1024).parse(nonce)).digest('hex');
}
export async function sealProviderOwnedSigninFlow(input: unknown, secret: string): Promise<string> {
  try {
    const clock = new Date();
    const flow = capture(input, clock);
    const secretKey = key(secret);
    // One conservative second covers the installed encoder's second-resolution
    // expiration. The protected absolute flow deadline still never extends.
    const remaining = Math.floor((milliseconds(flow.expiresAt) - Date.now()) / 1000) - 1;
    if (remaining <= 0) return refuse();
    const sealed = await encode({ secret: secretKey, maxAge: remaining, token: { purpose, flow } });
    if (!sealed || Buffer.byteLength(sealed) > limit || milliseconds(flow.expiresAt) <= Date.now()) return refuse();
    // Verify the real installed encoder's expiry and envelope before emitting
    // it; a clock rollover or delayed codec may never publish an unusable cap.
    await openProviderOwnedSigninFlow(sealed, flow.flowHash, secret);
    return sealed;
  } catch {
    return refuse();
  }
}
export async function openProviderOwnedSigninFlow(
  sealed: string,
  flowHash: string,
  secret: string,
): Promise<ProviderOwnedSigninFlow> {
  try {
    const expected = digest.parse(flowHash);
    if (!sealed || Buffer.byteLength(sealed) > limit) return refuse();
    const claims = await decode({ secret: key(secret), token: sealed });
    const payload = z
      .object({
        purpose: z.literal(purpose),
        flow: providerOwnedSigninFlowSchema,
        iat: z.number().int(),
        exp: z.number().int(),
        jti: z.uuid(),
      })
      .strict()
      .parse(claims);
    const clock = new Date();
    const flow = capture(payload.flow, clock);
    if (
      flow.flowHash !== expected ||
      !Number.isSafeInteger(payload.exp * 1000) ||
      payload.exp * 1000 > milliseconds(flow.expiresAt) ||
      payload.exp * 1000 <= clock.getTime()
    )
      return refuse();
    return flow;
  } catch {
    return refuse();
  }
}

export function requireProviderOwnedSigninActor(flow: ProviderOwnedSigninFlow, current: ProviderBrowserContext): void {
  requireProviderSecurityFlowActor(flow, current);
}
