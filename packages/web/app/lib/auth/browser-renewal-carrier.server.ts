import 'server-only';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  browserSelectionPossessionSchema,
  browserSourceCredentialSchema,
} from '@boardsesh/auth-protocol/browser-binding-v1';
import { browserRenewalPreparationSchema } from '@boardsesh/auth-protocol/browser-renewal-v1';
import { requireCoordinatorOrigin } from '@boardsesh/auth-protocol/browser-coordinator';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { browserRenewalSourceHash } from './browser-renewal-command-client.server';
import { BROWSER_PROOF_COOKIE_LIMITS } from './browser-proof-cookies.server';
import { boundedAuthCookiePairs } from './public-auth-request.server';

export const BROWSER_RENEWAL_CARRIER_PREFIX = '__Host-boardsesh.browser-renewal.';
const purpose = 'boardsesh-browser-renewal-actual-credentials-v1';
const chunkBytes = 2800;
const maximumChunks = 8;
const maximumOperations = 4;
const attributes = '; Path=/; Secure; HttpOnly; SameSite=Lax';
const capability = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const carrierSchema = z
  .object({
    version: z.literal(1),
    operationToken: capability,
    preparationToken: capability,
    nonceHash: digest,
    actor: browserSelectionPossessionSchema,
    candidate: browserSourceCredentialSchema,
    preparation: browserRenewalPreparationSchema,
    expiresAt: z.iso.datetime(),
  })
  .strict();
/** This is an actual credential carrier, NOT metadata-only flow state. Its
 * candidate never authenticates until exact durable completion and primary ACK. */
export type BrowserRenewalCarrier = z.infer<typeof carrierSchema>;
function refuse(): never {
  throw new AuthBackendUnavailableError();
}
export function browserRenewalOperationKey(operationToken: string): string {
  return createHash('sha256').update(capability.parse(operationToken)).digest('hex');
}
export function browserRenewalCarrierExpiry(preparation: BrowserRenewalCarrier['preparation']): string {
  return new Date(
    Math.min(
      Date.parse(preparation.expiresAt) + 300_000,
      Date.parse(preparation.targetExpiresAt),
      Date.parse(preparation.futureBrowserCursor.bindingExpiresAt),
    ),
  ).toISOString();
}
function capture(input: unknown, now: number): BrowserRenewalCarrier {
  const carrier = carrierSchema.parse(input);
  if (
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    Date.parse(carrier.expiresAt) <= now ||
    carrier.expiresAt !== browserRenewalCarrierExpiry(carrier.preparation) ||
    carrier.actor.version !== carrier.preparation.browserCursor.version ||
    carrier.actor.credential.kind !== carrier.preparation.credentialKind ||
    carrier.candidate.kind !== carrier.preparation.credentialKind ||
    browserRenewalSourceHash(carrier.actor.credential) !== carrier.preparation.sourceCredentialHash ||
    (carrier.actor.credential.kind === 'canonical-token' &&
      (carrier.candidate.kind !== 'canonical-token' || carrier.candidate.token !== carrier.actor.credential.token))
  )
    return refuse();
  return carrier;
}
function key(secret: string, canonicalOrigin: string): Buffer {
  requireCoordinatorOrigin(canonicalOrigin);
  if (!secret || secret.trim() !== secret || Buffer.byteLength(secret) < 32) return refuse();
  return Buffer.from(hkdfSync('sha256', secret, purpose, canonicalOrigin, 32));
}
function aad(canonicalOrigin: string, operationKey: string): Buffer {
  return Buffer.from(JSON.stringify([purpose, requireCoordinatorOrigin(canonicalOrigin), digest.parse(operationKey)]));
}
function decoded(encoded: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return refuse();
  const result = Buffer.from(encoded, 'base64url');
  if (result.toString('base64url') !== encoded) return refuse();
  return result;
}
export function sealBrowserRenewalCarrier(
  input: unknown,
  secret: string,
  canonicalOrigin: string,
  now = Date.now(),
): { readonly operationKey: string; readonly sealed: string; readonly expiresAt: string } {
  try {
    const carrier = capture(input, now);
    // Preparation cannot be initiated/replayed once its live-source window ends.
    if (
      Date.parse(carrier.preparation.expiresAt) <= now ||
      Date.parse(carrier.preparation.sourceExpiresAt) <= now ||
      Date.parse(carrier.preparation.browserCursor.bindingExpiresAt) <= now
    )
      return refuse();
    const operationKey = browserRenewalOperationKey(carrier.operationToken);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key(secret, canonicalOrigin), nonce);
    cipher.setAAD(aad(canonicalOrigin, operationKey));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(carrier), 'utf8'), cipher.final()]);
    const sealed = [
      'v1',
      nonce.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
    if (Buffer.byteLength(sealed) > chunkBytes * maximumChunks) return refuse();
    return Object.freeze({ operationKey, sealed, expiresAt: carrier.expiresAt });
  } catch {
    return refuse();
  }
}
function open(
  sealed: string,
  operationKey: string,
  secret: string,
  origin: string,
  now: number,
): Readonly<BrowserRenewalCarrier> {
  try {
    if (Buffer.byteLength(sealed) > chunkBytes * maximumChunks) return refuse();
    const pieces = sealed.split('.');
    if (pieces.length !== 4 || pieces[0] !== 'v1') return refuse();
    const nonce = decoded(pieces[1]),
      ciphertext = decoded(pieces[2]),
      tag = decoded(pieces[3]);
    if (nonce.length !== 12 || tag.length !== 16) return refuse();
    const decipher = createDecipheriv('aes-256-gcm', key(secret, origin), nonce);
    decipher.setAAD(aad(origin, operationKey));
    decipher.setAuthTag(tag);
    const bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const carrier = capture(JSON.parse(text) as unknown, now);
    if (JSON.stringify(carrier) !== text || browserRenewalOperationKey(carrier.operationToken) !== operationKey)
      return refuse();
    return Object.freeze({
      ...carrier,
      actor: Object.freeze({ ...carrier.actor, credential: Object.freeze({ ...carrier.actor.credential }) }),
      candidate: Object.freeze({ ...carrier.candidate }),
      preparation: Object.freeze({
        ...carrier.preparation,
        sourceCredentialProof: Object.freeze({ ...carrier.preparation.sourceCredentialProof }),
        browserCursor: Object.freeze({ ...carrier.preparation.browserCursor }),
        futureBrowserCursor: Object.freeze({ ...carrier.preparation.futureBrowserCursor }),
      }),
    });
  } catch {
    return refuse();
  }
}
type Pair = { readonly name: string; readonly content: string };
function families(header: string | null): ReadonlyMap<string, readonly Pair[]> {
  const reserved = boundedAuthCookiePairs(header).filter((pair) =>
    pair.name.startsWith(BROWSER_RENEWAL_CARRIER_PREFIX),
  );
  const grouped = new Map<string, Pair[]>();
  const names = new Set<string>();
  for (const pair of reserved) {
    const suffix = pair.name.slice(BROWSER_RENEWAL_CARRIER_PREFIX.length);
    const match = /^([a-f0-9]{64})(?:\.(0|[1-7]))?$/.exec(suffix);
    if (!match || names.has(pair.name) || !pair.content || Buffer.byteLength(pair.content) > chunkBytes)
      return refuse();
    names.add(pair.name);
    const previous = grouped.get(match[1]) ?? [];
    previous.push(pair);
    grouped.set(match[1], previous);
  }
  if (grouped.size > maximumOperations) return refuse();
  for (const [operationKey, pairs] of grouped) {
    const base = BROWSER_RENEWAL_CARRIER_PREFIX + operationKey;
    if (pairs.some((pair) => pair.name === base)) {
      if (pairs.length !== 1) return refuse();
    } else {
      pairs.sort((left, right) => Number(left.name.slice(base.length + 1)) - Number(right.name.slice(base.length + 1)));
      if (
        pairs.length < 2 ||
        pairs.length > maximumChunks ||
        pairs.some(
          (pair, index) =>
            pair.name !== `${base}.${index}` || (index < pairs.length - 1 && pair.content.length !== chunkBytes),
        )
      )
        return refuse();
    }
  }
  return grouped;
}
/** Selectors are control metadata only. The exact physical family and AEAD
 * custody remain mandatory; missing chunks or a different host refuse. */
export function readBrowserRenewalCarrier(
  header: string | null,
  operationKey: string,
  secret: string,
  canonicalOrigin: string,
  now = Date.now(),
): Readonly<BrowserRenewalCarrier> {
  try {
    digest.parse(operationKey);
    const selected = families(header).get(operationKey);
    if (!selected) return refuse();
    return open(selected.map((pair) => pair.content).join(''), operationKey, secret, canonicalOrigin, now);
  } catch {
    return refuse();
  }
}
export function observedBrowserRenewalOperationKeys(header: string | null): readonly string[] {
  try {
    return Object.freeze([...families(header).keys()]);
  } catch {
    return refuse();
  }
}
/** Build the entire projected next request, retaining all existing operations.
 * No future version-named proof or garbage collection is published here. */
export function prepareBrowserRenewalCarrierCookies(input: {
  readonly operationKey: string;
  readonly sealed: string;
  readonly expiresAt: string;
  readonly observedCookieHeader: string | null;
  readonly responseHeaderBudgetBytes?: number;
  readonly responseHeaderCountBudget?: number;
  readonly now?: number;
}): { readonly headers: readonly string[]; readonly projectedCookieHeader: string } {
  try {
    digest.parse(input.operationKey);
    const now = input.now ?? Date.now();
    const budget = input.responseHeaderBudgetBytes ?? BROWSER_PROOF_COOKIE_LIMITS.responseHeaderBytes;
    const countBudget = input.responseHeaderCountBudget ?? BROWSER_PROOF_COOKIE_LIMITS.responseHeaders;
    if (
      !Number.isSafeInteger(budget) ||
      budget < 1 ||
      budget > BROWSER_PROOF_COOKIE_LIMITS.responseHeaderBytes ||
      !Number.isSafeInteger(countBudget) ||
      countBudget < 1 ||
      countBudget > BROWSER_PROOF_COOKIE_LIMITS.responseHeaders
    )
      return refuse();
    const expiresAt = Date.parse(z.iso.datetime().parse(input.expiresAt));
    if (
      !Number.isSafeInteger(now) ||
      expiresAt <= now ||
      !/^[A-Za-z0-9_.-]+$/.test(input.sealed) ||
      !input.sealed ||
      Buffer.byteLength(input.sealed) > maximumChunks * chunkBytes
    )
      return refuse();
    const groups = families(input.observedCookieHeader);
    // Unique operation names must never overwrite an earlier physical carrier.
    if (groups.has(input.operationKey) || groups.size >= maximumOperations) return refuse();
    const chunks: string[] = [];
    for (let offset = 0; offset < input.sealed.length; offset += chunkBytes)
      chunks.push(input.sealed.slice(offset, offset + chunkBytes));
    const base = BROWSER_RENEWAL_CARRIER_PREFIX + input.operationKey;
    // Avoid rounding physical custody earlier than its exact server deadline.
    // Opening still checks that exact deadline, including the final millisecond.
    const expiryHeader = new Date(Math.ceil(expiresAt / 1000) * 1000).toUTCString();
    const headers = chunks.map(
      (chunk, index) =>
        `${chunks.length === 1 ? base : `${base}.${index}`}=${chunk}${attributes}; Expires=${expiryHeader}`,
    );
    const responseHeaders = headers;
    if (
      responseHeaders.length > countBudget ||
      responseHeaders.some(
        (header) => /[\r\n]/.test(header) || Buffer.byteLength(header) > BROWSER_PROOF_COOKIE_LIMITS.cookieHeaderBytes,
      ) ||
      responseHeaders.reduce((total, header) => total + Buffer.byteLength(`Set-Cookie: ${header}\r\n`), 0) > budget
    )
      return refuse();
    const projected = [
      ...boundedAuthCookiePairs(input.observedCookieHeader).map((pair) => `${pair.name}=${pair.content}`),
      ...headers.map((header) => header.split(';', 1)[0]),
    ];
    const projectedCookieHeader = projected.join('; ');
    if (
      projected.length > BROWSER_PROOF_COOKIE_LIMITS.incomingPairs ||
      Buffer.byteLength(projectedCookieHeader) > BROWSER_PROOF_COOKIE_LIMITS.projectedCookieHeaderBytes
    )
      return refuse();
    return Object.freeze({ headers: Object.freeze(headers), projectedCookieHeader });
  } catch {
    return refuse();
  }
}
