import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { browserBindingCursorSchema, type BrowserBindingCursor } from '@boardsesh/auth-protocol/browser-coordinator';

/** Unmounted codec. Correlation locates a row; only the backend can authenticate
 * the actual current-version source proof and authorize a selection transition. */
export const BROWSER_CORRELATION_COOKIE = '__Host-boardsesh.browser-binding';
export const BROWSER_PROOF_COOKIE_PREFIX = '__Host-boardsesh.browser-proof.';
export const BROWSER_CORRELATION_LEASE_SECONDS = 30 * 24 * 60 * 60;
export const BROWSER_PROOF_COOKIE_LIMITS = Object.freeze({
  incomingHeaderBytes: 32_768,
  incomingPairs: 128,
  credentialBytes: 16_384,
  chunkValueBytes: 3_000,
  proofChunks: 8,
  cookieHeaderBytes: 4_096,
  responseHeaderBytes: 32_768,
  projectedCookieHeaderBytes: 8_192,
  responseHeaders: 24,
  garbageCollectionHeaders: 16,
});
const attributes = '; Path=/; HttpOnly; Secure; SameSite=Lax';
const base64url = /^[A-Za-z0-9_-]+$/;
const correlationPattern = /^[A-Za-z0-9_-]{43}$/;
const proofNamePattern = /^__Host-boardsesh\.browser-proof\.([a-f0-9]{64})\.(0|[1-9][0-9]{0,9})(?:\.(0|[1-9][0-9]?))?$/;
const proofEnvelope = z
  .object({
    version: z.literal(1),
    kind: z.enum(['legacy-jwe', 'canonical-token']),
    credential: z.string().min(1),
  })
  .strict();
export interface BrowserCookieSourceProof {
  readonly kind: 'legacy-jwe' | 'canonical-token';
  readonly rawCredential: string;
}
export type BrowserProofCookieRead =
  | { readonly status: 'present'; readonly proof: BrowserCookieSourceProof }
  | { readonly status: 'missing' | 'invalid' };
export type BrowserCorrelationCookieRead =
  | { readonly status: 'present'; readonly token: string; readonly bindingId: string }
  | { readonly status: 'missing' | 'invalid' };
export class BrowserProofCookieError extends Error {
  constructor(
    readonly code:
      | 'INVALID_CURSOR'
      | 'INVALID_SOURCE'
      | 'INVALID_HEADER'
      | 'INVALID_FAMILY'
      | 'COOKIE_BUDGET'
      | 'INVALID_CORRELATION_SCOPE',
  ) {
    super(code);
    this.name = 'BrowserProofCookieError';
  }
}
interface ObservedCookie {
  readonly name: string;
  readonly content: string;
}
interface ProofName {
  readonly bindingId: string;
  readonly version: number;
  readonly chunk: number | null;
}
function cursor(input: BrowserBindingCursor): BrowserBindingCursor {
  const parsed = browserBindingCursorSchema.safeParse(input);
  if (!parsed.success) throw new BrowserProofCookieError('INVALID_CURSOR');
  return Object.freeze(parsed.data);
}
function bytes(input: string) {
  return Buffer.byteLength(input, 'utf8');
}
function hasForbiddenHeaderCharacter(header: string): boolean {
  for (let index = 0; index < header.length; index++) {
    const characterCode = header.charCodeAt(index);
    if ((characterCode < 32 && characterCode !== 9) || characterCode === 127) return true;
  }
  return false;
}
function observedCookies(header: string | null): readonly ObservedCookie[] {
  if (header === null || header === '') return [];
  if (
    bytes(header) > BROWSER_PROOF_COOKIE_LIMITS.incomingHeaderBytes ||
    hasForbiddenHeaderCharacter(header) ||
    Buffer.from(header, 'utf8').toString('utf8') !== header
  )
    throw new BrowserProofCookieError('INVALID_HEADER');
  const pieces = header.split(';');
  if (pieces.length > BROWSER_PROOF_COOKIE_LIMITS.incomingPairs) throw new BrowserProofCookieError('COOKIE_BUDGET');
  const observed: ObservedCookie[] = [];
  const seen = new Set<string>();
  for (const piece of pieces) {
    const pair = piece.trim();
    if (!pair) continue;
    const separator = pair.indexOf('=');
    const name = separator < 0 ? pair : pair.slice(0, separator).trim();
    const relevant = name.startsWith(BROWSER_PROOF_COOKIE_PREFIX) || name.startsWith(BROWSER_CORRELATION_COOKIE);
    if (relevant) {
      if (separator < 0 || seen.has(name)) throw new BrowserProofCookieError('INVALID_HEADER');
      seen.add(name);
    }
    // Unrelated pairs, including duplicate names at other paths, count toward
    // next-request capacity but can never be cleared by this codec.
    observed.push({ name, content: separator < 0 ? '' : pair.slice(separator + 1) });
  }
  return observed;
}
function parsedProofName(name: string): ProofName | null {
  const match = proofNamePattern.exec(name);
  if (!match) return null;
  const version = Number(match[2]);
  const chunk = match[3] === undefined ? null : Number(match[3]);
  if (
    !Number.isSafeInteger(version) ||
    version > 2_147_483_647 ||
    (chunk !== null && chunk >= BROWSER_PROOF_COOKIE_LIMITS.proofChunks)
  )
    return null;
  return { bindingId: match[1], version, chunk };
}
export function browserProofCookieName(input: BrowserBindingCursor): string {
  const selected = cursor(input);
  return `${BROWSER_PROOF_COOKIE_PREFIX}${selected.bindingId}.${selected.version}`;
}
function correlationTokenValid(token: string) {
  return (
    correlationPattern.test(token) &&
    Buffer.from(token, 'base64url').length === 32 &&
    Buffer.from(token, 'base64url').toString('base64url') === token
  );
}
export function readBrowserCorrelationCookie(header: string | null): BrowserCorrelationCookieRead {
  try {
    const candidates = observedCookies(header).filter((cookie) => cookie.name.startsWith(BROWSER_CORRELATION_COOKIE));
    if (!candidates.length) return { status: 'missing' };
    if (
      candidates.length !== 1 ||
      candidates[0].name !== BROWSER_CORRELATION_COOKIE ||
      !correlationTokenValid(candidates[0].content)
    )
      return { status: 'invalid' };
    const token = candidates[0].content;
    return { status: 'present', token, bindingId: createHash('sha256').update(token).digest('hex') };
  } catch {
    return { status: 'invalid' };
  }
}

/** Only a future, qualified canonical coordinator may publish this header.
 * Ordinary proof candidates never contain a correlation-cookie write/clear. */
export function buildCanonicalCoordinatorCorrelationCookie(input: {
  readonly servingOrigin: string;
  readonly canonicalOrigin: string;
  readonly token: string;
  readonly bindingId: string;
}): string {
  let address: URL;
  try {
    address = new URL(input.servingOrigin);
  } catch {
    throw new BrowserProofCookieError('INVALID_CORRELATION_SCOPE');
  }
  if (
    address.protocol !== 'https:' ||
    address.origin !== input.servingOrigin ||
    input.servingOrigin !== input.canonicalOrigin ||
    !correlationTokenValid(input.token) ||
    createHash('sha256').update(input.token).digest('hex') !== input.bindingId
  )
    throw new BrowserProofCookieError('INVALID_CORRELATION_SCOPE');
  return `${BROWSER_CORRELATION_COOKIE}=${input.token}${attributes}; Max-Age=${BROWSER_CORRELATION_LEASE_SECONDS}`;
}
function validCredential(credential: string) {
  return (
    credential.length > 0 &&
    bytes(credential) <= BROWSER_PROOF_COOKIE_LIMITS.credentialBytes &&
    /^[\x21-\x7e]+$/.test(credential)
  );
}
function encodeProof(proof: BrowserCookieSourceProof): string {
  if (!proof || !['legacy-jwe', 'canonical-token'].includes(proof.kind) || !validCredential(proof.rawCredential))
    throw new BrowserProofCookieError('INVALID_SOURCE');
  return Buffer.from(
    JSON.stringify({ version: 1, kind: proof.kind, credential: proof.rawCredential }),
    'utf8',
  ).toString('base64url');
}
function decodeProof(encoded: string): BrowserCookieSourceProof | null {
  if (!base64url.test(encoded)) return null;
  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.toString('base64url') !== encoded || decoded.length > BROWSER_PROOF_COOKIE_LIMITS.credentialBytes + 128)
    return null;
  const text = decoded.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(decoded)) return null;
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = proofEnvelope.safeParse(object);
  if (!parsed.success || !validCredential(parsed.data.credential) || JSON.stringify(parsed.data) !== text) return null;
  return Object.freeze({ kind: parsed.data.kind, rawCredential: parsed.data.credential });
}
function selectedFamily(
  observed: readonly ObservedCookie[],
  selected: BrowserBindingCursor,
): readonly ObservedCookie[] {
  const base = browserProofCookieName(selected);
  const family = observed.filter((cookie) => cookie.name === base || cookie.name.startsWith(`${base}.`));
  for (const cookie of family) {
    const name = parsedProofName(cookie.name);
    if (
      !name ||
      name.bindingId !== selected.bindingId ||
      name.version !== selected.version ||
      !cookie.content ||
      bytes(cookie.content) > BROWSER_PROOF_COOKIE_LIMITS.chunkValueBytes
    )
      throw new BrowserProofCookieError('INVALID_FAMILY');
  }
  const baseCookie = family.find((cookie) => cookie.name === base);
  if (baseCookie) {
    if (family.length !== 1) throw new BrowserProofCookieError('INVALID_FAMILY');
    return family;
  }
  const ordered = [...family].sort(
    (left, right) => (parsedProofName(left.name)?.chunk ?? -1) - (parsedProofName(right.name)?.chunk ?? -1),
  );
  if (
    ordered.length > BROWSER_PROOF_COOKIE_LIMITS.proofChunks ||
    ordered.some((cookie, index) => parsedProofName(cookie.name)?.chunk !== index)
  )
    throw new BrowserProofCookieError('INVALID_FAMILY');
  return ordered;
}

/** The cursor is from primary backend admission, never inferred from cookies or
 * a client header. Missing current proof never selects an older/higher family. */
export function readBrowserProofCookie(
  header: string | null,
  authoritativeCursor: BrowserBindingCursor,
): BrowserProofCookieRead {
  try {
    const selected = cursor(authoritativeCursor);
    const family = selectedFamily(observedCookies(header), selected);
    if (!family.length) return { status: 'missing' };
    const proof = decodeProof(family.map((cookie) => cookie.content).join(''));
    return proof ? { status: 'present', proof } : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}
function proofCookie(name: string, content: string, maxAge: number): string {
  const header = `${name}=${content}${attributes}; Max-Age=${maxAge}`;
  if (bytes(header) > BROWSER_PROOF_COOKIE_LIMITS.cookieHeaderBytes) throw new BrowserProofCookieError('COOKIE_BUDGET');
  return header;
}
function olderClears(observed: readonly ObservedCookie[], selected: BrowserBindingCursor): readonly string[] {
  const headers: string[] = [];
  for (const cookie of observed) {
    const name = parsedProofName(cookie.name);
    if (!name || name.bindingId !== selected.bindingId || name.version >= selected.version) continue;
    if (headers.length === BROWSER_PROOF_COOKIE_LIMITS.garbageCollectionHeaders) break;
    headers.push(proofCookie(cookie.name, '', 0));
  }
  return headers;
}
/** Cleanup uses only names actually observed on this request. The backend
 * supplies the current cursor even when its selected session is anonymous. */
export function buildObservedOlderBrowserProofCookieClears(
  authoritativeCursor: BrowserBindingCursor,
  observedCookieHeader: string | null,
): readonly string[] {
  return Object.freeze(olderClears(observedCookies(observedCookieHeader), cursor(authoritativeCursor)));
}
export interface BrowserProofCookieCandidate {
  readonly cursor: BrowserBindingCursor;
  readonly proofHeaders: readonly string[];
  readonly garbageCollectionHeaders: readonly string[];
  readonly headers: readonly string[];
  readonly headerBytes: number;
  readonly projectedCookieHeaderBytes: number;
}

/** Synchronous and immutable: call BEFORE any credential/selection mutation.
 * Header feasibility does not authorize a write; backend receipt/CAS still must.
 * Same-version chunk-layout changes are refused until revision/serialization is
 * qualified; GC must never delete a current-version cookie. */
export function buildBrowserProofCookieCandidate(input: {
  readonly cursor: BrowserBindingCursor;
  readonly proof: BrowserCookieSourceProof;
  readonly proofMaxAgeSeconds: number;
  readonly observedCookieHeader: string | null;
  readonly responseHeaderBudgetBytes?: number;
  readonly requestCookieHeaderBudgetBytes?: number;
  /** Trusted server planning only. Keep exact old actor possession available
   * for bounded result ACK; no HTTP input may select this behavior. */
  readonly retainObservedProofCookies?: boolean;
}): BrowserProofCookieCandidate {
  const selected = cursor(input.cursor);
  if (input.retainObservedProofCookies !== undefined && typeof input.retainObservedProofCookies !== 'boolean')
    throw new BrowserProofCookieError('INVALID_SOURCE');
  if (
    !Number.isSafeInteger(input.proofMaxAgeSeconds) ||
    input.proofMaxAgeSeconds < 1 ||
    input.proofMaxAgeSeconds > BROWSER_CORRELATION_LEASE_SECONDS
  )
    throw new BrowserProofCookieError('INVALID_SOURCE');
  const budget = input.responseHeaderBudgetBytes ?? BROWSER_PROOF_COOKIE_LIMITS.responseHeaderBytes;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > BROWSER_PROOF_COOKIE_LIMITS.responseHeaderBytes)
    throw new BrowserProofCookieError('COOKIE_BUDGET');
  const requestBudget = input.requestCookieHeaderBudgetBytes ?? BROWSER_PROOF_COOKIE_LIMITS.projectedCookieHeaderBytes;
  if (
    !Number.isSafeInteger(requestBudget) ||
    requestBudget < 1 ||
    requestBudget > BROWSER_PROOF_COOKIE_LIMITS.projectedCookieHeaderBytes
  )
    throw new BrowserProofCookieError('COOKIE_BUDGET');
  const observed = observedCookies(input.observedCookieHeader);
  const existing = selectedFamily(observed, selected);
  const encoded = encodeProof(input.proof);
  const base = browserProofCookieName(selected);
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += BROWSER_PROOF_COOKIE_LIMITS.chunkValueBytes)
    chunks.push(encoded.slice(offset, offset + BROWSER_PROOF_COOKIE_LIMITS.chunkValueBytes));
  if (chunks.length > BROWSER_PROOF_COOKIE_LIMITS.proofChunks) throw new BrowserProofCookieError('COOKIE_BUDGET');
  const proofHeaders = chunks.map((content, index) =>
    proofCookie(chunks.length === 1 ? base : `${base}.${index}`, content, input.proofMaxAgeSeconds),
  );
  const names = proofHeaders.map((header) => header.slice(0, header.indexOf('=')));
  if (existing.length && (existing.length !== names.length || existing.some((cookie) => !names.includes(cookie.name))))
    throw new BrowserProofCookieError('INVALID_FAMILY');
  const garbageCollectionHeaders = input.retainObservedProofCookies === true ? [] : olderClears(observed, selected);
  const headers = [...proofHeaders, ...garbageCollectionHeaders];
  const headerBytes = headers.reduce((size, header) => size + bytes(`Set-Cookie: ${header}\r\n`), 0);
  if (headers.length > BROWSER_PROOF_COOKIE_LIMITS.responseHeaders || headerBytes > budget)
    throw new BrowserProofCookieError('COOKIE_BUDGET');
  const changedNames = new Set(headers.map((header) => header.slice(0, header.indexOf('='))));
  const projected = [
    ...observed.filter((cookie) => !changedNames.has(cookie.name)).map((cookie) => `${cookie.name}=${cookie.content}`),
    ...proofHeaders.map((header) => header.split(';', 1)[0]),
  ];
  const projectedCookieHeaderBytes = bytes(projected.join('; '));
  if (projectedCookieHeaderBytes > requestBudget || projected.length > BROWSER_PROOF_COOKIE_LIMITS.incomingPairs)
    throw new BrowserProofCookieError('COOKIE_BUDGET');
  return Object.freeze({
    cursor: selected,
    proofHeaders: Object.freeze(proofHeaders),
    garbageCollectionHeaders: Object.freeze(garbageCollectionHeaders),
    headers: Object.freeze(headers),
    headerBytes,
    projectedCookieHeaderBytes,
  });
}
