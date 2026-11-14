import 'server-only';
import { webCredentialProofSchema, type WebCredentialProof } from '@boardsesh/auth-protocol';
import type { BrowserCoordinatorResult } from '@boardsesh/auth-protocol/browser-coordinator';
import type { z } from 'zod';
import type { browserRenewalBrowserPreparationReplySchema } from '@boardsesh/auth-protocol/browser-renewal-browser-v1';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import {
  BROWSER_PROOF_COOKIE_LIMITS,
  BROWSER_CORRELATION_COOKIE,
  BROWSER_PROOF_COOKIE_PREFIX,
  buildBrowserProofCookieCandidate,
  buildCanonicalCoordinatorCorrelationCookie,
  readBrowserCorrelationCookie,
  readBrowserProofCookie,
} from './browser-proof-cookies.server';
import { BROWSER_RENEWAL_CARRIER_PREFIX, type BrowserRenewalCarrier } from './browser-renewal-carrier.server';
import { browserRenewalSourceHash } from './browser-renewal-command-client.server';
import type { AdmittedBrowserSelection } from './presented-browser-selection.server';
import { boundedAuthCookiePairs } from './public-auth-request.server';

type ControlReply = BrowserCoordinatorResult | z.infer<typeof browserRenewalBrowserPreparationReplySchema>;
type BrowserBindingCursor = AdmittedBrowserSelection['cursor'];
export function renewalSourceProof(selection: AdmittedBrowserSelection): WebCredentialProof {
  return webCredentialProofSchema.parse({
    version: 1,
    userId: selection.session.userId,
    authSessionId: selection.session.authSessionId,
    generation: selection.session.generation,
    authenticatedAt: selection.session.authenticatedAt,
    linkGuarded: selection.session.linkGuarded,
    ...(selection.session.requiresAccountCutoff ? { requiresAccountCutoff: true } : {}),
  });
}
export function sameRenewalCursor(left: BrowserBindingCursor, right: BrowserBindingCursor): boolean {
  return (
    left.bindingId === right.bindingId &&
    left.version === right.version &&
    left.bindingExpiresAt === right.bindingExpiresAt
  );
}
export function sameRenewalSelection(
  carrier: Readonly<BrowserRenewalCarrier>,
  selected: AdmittedBrowserSelection,
  phase: 'source' | 'candidate',
): boolean {
  const expectedCursor =
    phase === 'source' ? carrier.preparation.browserCursor : carrier.preparation.futureBrowserCursor;
  const credential = phase === 'source' ? carrier.actor.credential : carrier.candidate;
  return (
    sameRenewalCursor(expectedCursor, selected.cursor) &&
    selected.actor.version === expectedCursor.version &&
    browserRenewalSourceHash(selected.actor.credential) === browserRenewalSourceHash(credential) &&
    JSON.stringify(renewalSourceProof(selected)) === JSON.stringify(carrier.preparation.sourceCredentialProof) &&
    selected.session.expiresAt ===
      (phase === 'source' ? carrier.preparation.sourceExpiresAt : carrier.preparation.targetExpiresAt) &&
    selected.user.id === carrier.preparation.sourceCredentialProof.userId
  );
}
export function renewalCorrelationRefresh(cookieHeader: string | null, origin: string, bindingId: string): string {
  const actual = readBrowserCorrelationCookie(cookieHeader);
  if (actual.status !== 'present' || actual.bindingId !== bindingId) throw new AuthBackendUnavailableError();
  return buildCanonicalCoordinatorCorrelationCookie({
    servingOrigin: origin,
    canonicalOrigin: origin,
    token: actual.token,
    bindingId,
  });
}
/** Buffer and validate every response cookie and the complete next request
 * before a state-changing finalizer can be invoked. */
export function bufferBrowserRenewalResponse(
  body: ControlReply,
  status: number,
  cookies: readonly string[],
  observedCookieHeader: string | null,
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'CDN-Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, follow',
    'X-Content-Type-Options': 'nosniff',
  });
  if (status === 503 || status === 429) headers.set('Retry-After', '1');
  if (cookies.length > BROWSER_PROOF_COOKIE_LIMITS.responseHeaders) throw new AuthBackendUnavailableError();
  const replaced = new Set<string>();
  const added: string[] = [];
  for (const cookie of cookies) {
    if (/[\r\n]/.test(cookie) || Buffer.byteLength(cookie) > BROWSER_PROOF_COOKIE_LIMITS.cookieHeaderBytes)
      throw new AuthBackendUnavailableError();
    const pair = cookie.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator < 1) throw new AuthBackendUnavailableError();
    const name = pair.slice(0, separator),
      content = pair.slice(separator + 1);
    if (
      replaced.has(name) ||
      !(
        name === BROWSER_CORRELATION_COOKIE ||
        name.startsWith(BROWSER_PROOF_COOKIE_PREFIX) ||
        name.startsWith(BROWSER_RENEWAL_CARRIER_PREFIX)
      )
    )
      throw new AuthBackendUnavailableError();
    replaced.add(name);
    if (content) added.push(pair);
    headers.append('Set-Cookie', cookie);
  }
  let bytes = cookies.reduce((total, cookie) => total + Buffer.byteLength(`Set-Cookie: ${cookie}\r\n`), 0);
  for (const [name, content] of headers)
    if (name !== 'set-cookie') bytes += Buffer.byteLength(`${name}: ${content}\r\n`);
  const projected = [
    ...boundedAuthCookiePairs(observedCookieHeader)
      .filter((pair) => !replaced.has(pair.name))
      .map((pair) => `${pair.name}=${pair.content}`),
    ...added,
  ];
  const serialized = JSON.stringify(body);
  if (
    bytes > BROWSER_PROOF_COOKIE_LIMITS.responseHeaderBytes ||
    (cookies.length > 0 &&
      (projected.length > BROWSER_PROOF_COOKIE_LIMITS.incomingPairs ||
        Buffer.byteLength(projected.join('; ')) > BROWSER_PROOF_COOKIE_LIMITS.projectedCookieHeaderBytes)) ||
    Buffer.byteLength(serialized) > 8192
  )
    throw new AuthBackendUnavailableError();
  return new Response(serialized, { status, headers });
}
export function bufferBrowserRenewalCandidate(
  carrier: Readonly<BrowserRenewalCarrier>,
  cookieHeader: string | null,
  origin: string,
): Response {
  const cursor = carrier.preparation.futureBrowserCursor;
  const remaining = Math.floor(
    (Math.min(Date.parse(carrier.preparation.targetExpiresAt), Date.parse(cursor.bindingExpiresAt)) - Date.now()) /
      1000,
  );
  const rawCredential =
    carrier.candidate.kind === 'canonical-token' ? carrier.candidate.token : carrier.candidate.credential;
  const proof = buildBrowserProofCookieCandidate({
    cursor: { bindingId: cursor.bindingId, version: cursor.version },
    proof: { kind: carrier.candidate.kind, rawCredential },
    proofMaxAgeSeconds: remaining,
    retainObservedProofCookies: true,
    observedCookieHeader: cookieHeader,
  });
  return bufferBrowserRenewalResponse(
    { status: 'ready', cursor: { bindingId: cursor.bindingId, version: cursor.version } },
    200,
    [...proof.headers, renewalCorrelationRefresh(cookieHeader, origin, cursor.bindingId)],
    cookieHeader,
  );
}
/** Cleanup is allowed only after the next request actually contains the complete
 * exact current proof and its durable operation has acknowledged that candidate. */
export function bufferBrowserRenewalCleanup(
  carrier: Readonly<BrowserRenewalCarrier>,
  operationKey: string,
  cookieHeader: string | null,
  origin: string,
  selected: AdmittedBrowserSelection,
): Response {
  if (!sameRenewalSelection(carrier, selected, 'candidate')) throw new AuthBackendUnavailableError();
  const physical = readBrowserProofCookie(cookieHeader, {
    bindingId: selected.cursor.bindingId,
    version: selected.cursor.version,
  });
  if (
    physical.status !== 'present' ||
    physical.proof.kind !== carrier.candidate.kind ||
    physical.proof.rawCredential !==
      (carrier.candidate.kind === 'canonical-token' ? carrier.candidate.token : carrier.candidate.credential)
  )
    throw new AuthBackendUnavailableError();
  const observed = boundedAuthCookiePairs(cookieHeader);
  const carrierBase = BROWSER_RENEWAL_CARRIER_PREFIX + operationKey;
  const names = observed
    .filter((pair) => pair.name === carrierBase || pair.name.startsWith(carrierBase + '.'))
    .map((pair) => pair.name);
  const oldCursor = carrier.preparation.browserCursor;
  const old = readBrowserProofCookie(cookieHeader, { bindingId: oldCursor.bindingId, version: oldCursor.version });
  if (
    old.status === 'present' &&
    old.proof.kind === carrier.actor.credential.kind &&
    old.proof.rawCredential ===
      (carrier.actor.credential.kind === 'canonical-token'
        ? carrier.actor.credential.token
        : carrier.actor.credential.credential)
  ) {
    const base = `${BROWSER_PROOF_COOKIE_PREFIX}${oldCursor.bindingId}.${oldCursor.version}`;
    names.push(
      ...observed.filter((pair) => pair.name === base || pair.name.startsWith(base + '.')).map((pair) => pair.name),
    );
  }
  if (names.length > BROWSER_PROOF_COOKIE_LIMITS.garbageCollectionHeaders) throw new AuthBackendUnavailableError();
  const clears = names.map((name) => `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
  return bufferBrowserRenewalResponse(
    { status: 'ready', cursor: { bindingId: selected.cursor.bindingId, version: selected.cursor.version } },
    200,
    [renewalCorrelationRefresh(cookieHeader, origin, selected.cursor.bindingId), ...clears],
    cookieHeader,
  );
}
