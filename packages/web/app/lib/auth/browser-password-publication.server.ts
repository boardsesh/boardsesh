import 'server-only';
import {
  browserPasswordBrowserReplySchema,
  type BrowserPasswordBrowserReply,
} from '@boardsesh/auth-protocol/browser-password-browser-v1';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { BROWSER_PROOF_COOKIE_LIMITS, buildBrowserProofCookieCandidate } from './browser-proof-cookies.server';
import { requireProviderCookieCapacity } from './provider-cookie-capacity.server';
import {
  buildObservedBrowserPasswordCustodyClears,
  type BrowserPasswordCustody,
} from './browser-password-custody.server';

const refuse = (): never => {
  throw new AuthBackendUnavailableError();
};
export function passwordBrowserResponse(
  body: BrowserPasswordBrowserReply,
  status: number,
  cookieHeaders: readonly string[],
  observedHeader: string | null,
): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(browserPasswordBrowserReplySchema.parse(body)));
  if (bytes.byteLength > 16_384 || cookieHeaders.length > BROWSER_PROOF_COOKIE_LIMITS.responseHeaders) return refuse();
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, follow',
  });
  for (const header of cookieHeaders) headers.append('Set-Cookie', header);
  const headerBytes =
    [...headers]
      .filter(([name]) => name !== 'set-cookie')
      .reduce((sum, [name, content]) => sum + Buffer.byteLength(`${name}: ${content}\r\n`), 0) +
    headers.getSetCookie().reduce((sum, header) => sum + Buffer.byteLength(`Set-Cookie: ${header}\r\n`), 0);
  if (headerBytes > BROWSER_PROOF_COOKIE_LIMITS.responseHeaderBytes) return refuse();
  requireProviderCookieCapacity(observedHeader, headers);
  return new Response(bytes, { status, headers });
}
export function passwordTargetCookieHeaders(
  custody: Readonly<BrowserPasswordCustody>,
  observedHeader: string | null,
  now = new Date(),
): readonly string[] {
  const seconds = Math.floor((Date.parse(custody.preparation.credentialExpiresAt) - now.getTime()) / 1_000);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return refuse();
  const future = custody.preparation.futureBrowserCursor;
  return buildBrowserProofCookieCandidate({
    cursor: { bindingId: future.bindingId, version: future.version },
    proof: {
      kind: custody.candidate.kind,
      rawCredential:
        custody.candidate.kind === 'canonical-token' ? custody.candidate.token : custody.candidate.credential,
    },
    proofMaxAgeSeconds: seconds,
    observedCookieHeader: observedHeader,
    retainObservedProofCookies: true,
  }).headers;
}
/** Fully materialized BEFORE the one finalizer. No old proof/correlation or
 * custody family is removed by credential publication. */
export function preparePasswordTargetResponse(
  custody: Readonly<BrowserPasswordCustody>,
  observedHeader: string | null,
  outcome: 'committed' | 'recovered' = 'committed',
) {
  const future = custody.preparation.futureBrowserCursor;
  const cookieHeaders = passwordTargetCookieHeaders(custody, observedHeader);
  const response = passwordBrowserResponse(
    {
      status: outcome,
      operationKey: custody.operationKey,
      cursor: { bindingId: future.bindingId, version: future.version },
    },
    200,
    cookieHeaders,
    observedHeader,
  );
  // Only known Host proof writes are projected for an actual target primary
  // read. A metadata identity never substitutes for these exact candidate bytes.
  const replacements = new Map(
    cookieHeaders.map((header) => {
      const pair = header.split(';', 1)[0],
        separator = pair.indexOf('=');
      return [pair.slice(0, separator), pair.slice(separator + 1)] as const;
    }),
  );
  const retained = (observedHeader ?? '')
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .filter((pair) => !replacements.has(pair.split('=', 1)[0]));
  const projectedCookieHeader = retained
    .concat([...replacements].map(([name, content]) => `${name}=${content}`))
    .join('; ');
  return Object.freeze({ response, projectedCookieHeader });
}
export function preparePasswordConfirmationResponse(
  custody: Readonly<BrowserPasswordCustody>,
  observedHeader: string | null,
): Response {
  const future = custody.preparation.futureBrowserCursor;
  return passwordBrowserResponse(
    {
      status: 'confirmed',
      operationKey: custody.operationKey,
      cursor: { bindingId: future.bindingId, version: future.version },
      url: custody.destination,
    },
    200,
    buildObservedBrowserPasswordCustodyClears(observedHeader, custody.operationKey),
    observedHeader,
  );
}
