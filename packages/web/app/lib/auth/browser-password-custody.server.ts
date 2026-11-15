import 'server-only';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  browserPasswordPreparationSchema,
  browserPasswordSourceSchema,
} from '@boardsesh/auth-protocol/browser-password-v1';
import { browserSourceCredentialSchema } from '@boardsesh/auth-protocol/browser-binding-v1';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { boundedAuthCookiePairs } from './public-auth-request.server';
import { browserPasswordCandidateHash, browserPasswordTokenHash } from './browser-password-command-client.server';

export const BROWSER_PASSWORD_CUSTODY_PREFIX = '__Host-boardsesh.password-signin.';
export const BROWSER_PASSWORD_PENDING_PREFIX = '__Host-boardsesh.password-signin-pending.';
export const BROWSER_PASSWORD_CUSTODY_LIMITS = Object.freeze({
  chunkBytes: 3_000,
  chunks: 8,
  valueBytes: 24_000,
  families: 4,
});
const purpose = 'boardsesh-browser-password-candidate-custody-v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const attributes = '; Path=/; HttpOnly; Secure; SameSite=Lax';
const refuse = (): never => {
  throw new AuthBackendUnavailableError();
};
function clock(now: Date): number {
  const milliseconds = now.getTime();
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : refuse();
}
export const browserPasswordCustodySchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal(purpose),
    operationKey: digest,
    canonicalOrigin: z.url(),
    source: browserPasswordSourceSchema,
    operationToken: opaque,
    browserIntentToken: opaque,
    preparation: browserPasswordPreparationSchema,
    candidate: browserSourceCredentialSchema,
    destination: z.url().max(4_096),
  })
  .strict()
  .superRefine((custody, context) => {
    const prepared = custody.preparation;
    const origin = new URL(custody.canonicalOrigin),
      destination = new URL(custody.destination);
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== custody.canonicalOrigin ||
      destination.protocol !== 'https:' ||
      destination.username ||
      destination.password ||
      destination.hash ||
      prepared.nonceHash !== custody.operationKey ||
      prepared.browserCursor.bindingId !== browserPasswordTokenHash(custody.source.bindingToken) ||
      prepared.browserCursor.version !== custody.source.expectedVersion ||
      prepared.source.state !== custody.source.state ||
      prepared.credentialKind !== custody.candidate.kind ||
      (custody.source.state === 'selected' &&
        prepared.source.state === 'selected' &&
        prepared.source.credentialHash !== browserPasswordCandidateHash(custody.source.actor.credential)) ||
      (custody.candidate.kind === 'canonical-token' &&
        prepared.proposedCanonicalTokenHash !== browserPasswordCandidateHash(custody.candidate))
    )
      context.addIssue({ code: 'custom', message: 'Invalid password custody correlation' });
  });
export type BrowserPasswordCustody = z.infer<typeof browserPasswordCustodySchema>;

function key(secret: string): Buffer {
  if (!secret || secret !== secret.trim() || Buffer.byteLength(secret) < 32) return refuse();
  return Buffer.from(hkdfSync('sha256', secret, purpose, 'canonical-password-custody-cookie-key', 32));
}
function aad(origin: string, operationKey: string): Buffer {
  const address = new URL(origin);
  if (address.protocol !== 'https:' || address.origin !== origin) return refuse();
  return Buffer.from(JSON.stringify([purpose, origin, digest.parse(operationKey)]));
}
export function browserPasswordCustodyCookieName(operationKey: string): string {
  return BROWSER_PASSWORD_CUSTODY_PREFIX + digest.parse(operationKey);
}
export function browserPasswordPendingCookieName(operationKey: string): string {
  return BROWSER_PASSWORD_PENDING_PREFIX + digest.parse(operationKey);
}

/** Encrypt actual candidate bytes before the FIRST response. Operation/origin
 * AAD and a purpose-derived key prevent use as any other cookie capability. */
export function sealBrowserPasswordCustody(input: unknown, secret: string, now = new Date()): string {
  try {
    const custody = browserPasswordCustodySchema.parse(input);
    const milliseconds = clock(now);
    if (
      milliseconds < Date.parse(custody.preparation.preparedAt) ||
      milliseconds >= Date.parse(custody.preparation.expiresAt)
    )
      return refuse();
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key(secret), nonce);
    cipher.setAAD(aad(custody.canonicalOrigin, custody.operationKey));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(custody), 'utf8'), cipher.final()]);
    const sealed = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64url');
    if (Buffer.byteLength(sealed) > BROWSER_PASSWORD_CUSTODY_LIMITS.valueBytes) return refuse();
    return sealed;
  } catch {
    return refuse();
  }
}
export type BrowserPasswordCustodyOpening =
  | { readonly status: 'live'; readonly custody: Readonly<BrowserPasswordCustody> }
  | { readonly status: 'expired'; readonly custody: Readonly<BrowserPasswordCustody> };

/** Expired authenticated envelopes may authorize their observed-family clear,
 * never publication. Recovery ignores only the OLD source/preparation expiry. */
export function openBrowserPasswordCustody(
  sealed: string,
  operationKey: string,
  canonicalOrigin: string,
  secret: string,
  now = new Date(),
): BrowserPasswordCustodyOpening {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(sealed) || Buffer.byteLength(sealed) > BROWSER_PASSWORD_CUSTODY_LIMITS.valueBytes)
      return refuse();
    const encoded = Buffer.from(sealed, 'base64url');
    if (encoded.length <= 28 || encoded.toString('base64url') !== sealed) return refuse();
    const decipher = createDecipheriv('aes-256-gcm', key(secret), encoded.subarray(0, 12));
    decipher.setAAD(aad(canonicalOrigin, operationKey));
    decipher.setAuthTag(encoded.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(encoded.subarray(12, -16)), decipher.final()]);
    const custody = browserPasswordCustodySchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)),
    );
    const milliseconds = clock(now);
    if (
      custody.operationKey !== operationKey ||
      custody.canonicalOrigin !== canonicalOrigin ||
      milliseconds < Date.parse(custody.preparation.preparedAt)
    )
      return refuse();
    return Object.freeze({
      status:
        milliseconds >=
        Math.min(Date.parse(custody.preparation.acknowledgeUntil), Date.parse(custody.preparation.credentialExpiresAt))
          ? 'expired'
          : 'live',
      custody: Object.freeze(custody),
    });
  } catch {
    return refuse();
  }
}

function observed(header: string | null) {
  const pairs = boundedAuthCookiePairs(header);
  const relevant = pairs.filter((pair) => pair.name.startsWith(BROWSER_PASSWORD_CUSTODY_PREFIX));
  if (new Set(relevant.map((pair) => pair.name)).size !== relevant.length) return refuse();
  return relevant;
}
export function observedBrowserPasswordOperationKeys(header: string | null): readonly string[] {
  const keys = new Set<string>();
  for (const pair of observed(header)) {
    const match = /^__Host-boardsesh\.password-signin\.([a-f0-9]{64})(?:\.(0|[1-9][0-9]?))?$/.exec(pair.name);
    if (!match || (match[2] !== undefined && Number(match[2]) >= BROWSER_PASSWORD_CUSTODY_LIMITS.chunks))
      return refuse();
    keys.add(match[1]);
  }
  if (keys.size > BROWSER_PASSWORD_CUSTODY_LIMITS.families) return refuse();
  return Object.freeze([...keys]);
}
function family(header: string | null, operationKey: string) {
  const base = browserPasswordCustodyCookieName(operationKey);
  const matches = observed(header).filter((pair) => pair.name === base || pair.name.startsWith(base + '.'));
  if (!matches.length) return [];
  if (
    matches.some(
      (pair) =>
        !pair.content ||
        Buffer.byteLength(pair.content) > BROWSER_PASSWORD_CUSTODY_LIMITS.chunkBytes ||
        !/^[A-Za-z0-9_-]+$/.test(pair.content),
    )
  )
    return refuse();
  if (matches.some((pair) => pair.name === base)) {
    if (matches.length !== 1) return refuse();
    return matches;
  }
  matches.sort((left, right) => Number(left.name.slice(base.length + 1)) - Number(right.name.slice(base.length + 1)));
  if (
    matches.length > BROWSER_PASSWORD_CUSTODY_LIMITS.chunks ||
    matches.some((pair, index) => pair.name !== `${base}.${index}`)
  )
    return refuse();
  return matches;
}
export function readBrowserPasswordCustody(header: string | null, operationKey: string): string | null {
  const selected = family(header, operationKey);
  return selected.length ? selected.map((pair) => pair.content).join('') : null;
}
export function buildBrowserPasswordCustodyCookies(
  custody: BrowserPasswordCustody,
  sealed: string,
  observedHeader: string | null,
  now = new Date(),
): readonly string[] {
  const base = browserPasswordCustodyCookieName(custody.operationKey);
  if (
    observedBrowserPasswordOperationKeys(observedHeader).length >= BROWSER_PASSWORD_CUSTODY_LIMITS.families ||
    family(observedHeader, custody.operationKey).length ||
    !/^[A-Za-z0-9_-]+$/.test(sealed) ||
    Buffer.byteLength(sealed) > BROWSER_PASSWORD_CUSTODY_LIMITS.valueBytes
  )
    return refuse();
  const seconds = Math.floor((Date.parse(custody.preparation.acknowledgeUntil) - clock(now)) / 1_000);
  if (seconds <= 0 || seconds > 300) return refuse();
  const chunks: string[] = [];
  for (let offset = 0; offset < sealed.length; offset += BROWSER_PASSWORD_CUSTODY_LIMITS.chunkBytes)
    chunks.push(sealed.slice(offset, offset + BROWSER_PASSWORD_CUSTODY_LIMITS.chunkBytes));
  if (!chunks.length || chunks.length > BROWSER_PASSWORD_CUSTODY_LIMITS.chunks) return refuse();
  return Object.freeze(
    chunks.map(
      (content, index) =>
        `${chunks.length === 1 ? base : `${base}.${index}`}=${content}${attributes}; Max-Age=${seconds}`,
    ),
  );
}
/** Only a complete, actually observed operation family may be cleared. */
export function buildObservedBrowserPasswordCustodyClears(
  header: string | null,
  operationKey: string,
): readonly string[] {
  return Object.freeze(family(header, operationKey).map((pair) => `${pair.name}=${attributes}; Max-Age=0`));
}
