import 'server-only';
import { createHash } from 'node:crypto';
import { decode } from 'next-auth/jwt';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import {
  BROWSER_COORDINATOR_PUBLIC_PATHS,
  type BrowserCoordinatorResult,
} from '@boardsesh/auth-protocol/browser-coordinator';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';
import {
  createBrowserBindingCommandClient,
  type BrowserBindingCommandClient,
} from './browser-binding-command-client.server';
import {
  BROWSER_PROOF_COOKIE_PREFIX,
  BROWSER_PROOF_COOKIE_LIMITS,
  buildBrowserProofCookieCandidate,
  buildCanonicalCoordinatorCorrelationCookie,
  readBrowserCorrelationCookie,
} from './browser-proof-cookies.server';
import { readPresentedBrowserSelection, type PresentedBrowserSelection } from './presented-browser-selection.server';
import { admitPresentedWebCredential } from './credential-admission.server';
import { readBootstrapLegacyCredential } from './browser-bootstrap-legacy.server';
import { publicBrowserCoordinatorReady } from './browser-coordinator-readiness';
import { resolvePublicAuthOrigin } from './canonical-auth-url';
import { checkRateLimit } from './rate-limiter';
import { trustedClientRateLimitKey } from './trusted-client-ip.server';

export const BROWSER_COORDINATOR_PATHS = BROWSER_COORDINATOR_PUBLIC_PATHS;
type Observation = BrowserCoordinatorResult | { readonly status: 'missing-binding' };
type RefusalOutcome = Exclude<Observation['status'], 'ready' | 'missing-binding'>;
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly outcome: RefusalOutcome,
  ) {
    super(outcome);
  }
}
function refuse(status = 503, outcome: RefusalOutcome = 'unavailable'): never {
  throw new Refusal(status, outcome);
}
function response(body: Observation, status = 200, cookies: readonly string[] = []): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    'CDN-Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, follow',
  });
  if (status === 503) headers.set('Retry-After', '1');
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}
function missingCookies(header: string | null): string | null {
  const correlation = readBrowserCorrelationCookie(header);
  if (correlation.status !== 'missing') return refuse(409, 'conflict');
  // Orphan or malformed reserved proof names never authorize a fresh binding.
  if ((header ?? '').split(';').some((piece) => piece.trim().split('=', 1)[0].startsWith(BROWSER_PROOF_COOKIE_PREFIX)))
    return refuse(409, 'proof-required');
  return readBootstrapLegacyCredential(header);
}
async function emptyObject(request: Request): Promise<void> {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json')
    return refuse(400);
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > 64)) return refuse(400);
  const reader = request.body?.getReader();
  if (!reader) return refuse(400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Refusal(400, 'unavailable')), 2_000);
  });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > 64) return refuse(400);
      chunks.push(chunk.value);
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length)
      return refuse(400);
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Thin canonical-www adapters. All identity/selection changes remain in the
 * private backend. Source-only readiness never accepts an HTTP override. */
export function createBrowserCoordinatorRoutes(
  options: {
    readonly environment?: AuthServiceEnvironment;
    readonly ready?: () => boolean;
    readonly clientFactory?: () => BrowserBindingCommandClient;
    readonly readSelection?: (cookies: string | null) => Promise<PresentedBrowserSelection>;
    readonly admitLegacy?: (credential: string) => Promise<string | null>;
    readonly legacyExpiry?: (credential: string) => Promise<number | null>;
    readonly rateLimit?: (request: Request, operation: keyof typeof BROWSER_COORDINATOR_PATHS) => boolean;
  } = {},
) {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const ready = options.ready ?? publicBrowserCoordinatorReady;
  const clientFactory = options.clientFactory ?? (() => createBrowserBindingCommandClient({ environment }));
  const readSelection = options.readSelection ?? ((cookies) => readPresentedBrowserSelection(cookies, { environment }));
  const admitLegacy = options.admitLegacy ?? admitPresentedWebCredential;
  const legacyExpiry =
    options.legacyExpiry ??
    (async (credential: string) => {
      const token = await decode({ token: credential, secret: environment.NEXTAUTH_SECRET ?? '' });
      return typeof token?.exp === 'number' && Number.isSafeInteger(token.exp) ? token.exp * 1_000 : null;
    });
  const rateLimit =
    options.rateLimit ??
    ((request, operation) =>
      checkRateLimit(
        `browser-coordinator:${operation}:${trustedClientRateLimitKey(request)}`,
        operation === 'initialize' ? 20 : 120,
      ).limited);
  async function run(request: Request, operation: keyof typeof BROWSER_COORDINATOR_PATHS): Promise<Response> {
    try {
      if (!ready() || browserBindingMode(environment) !== 'backend-staging') return refuse();
      const origin = resolvePublicAuthOrigin(environment);
      if (!origin || new URL(origin).protocol !== 'https:') return refuse();
      const url = new URL(request.url);
      if (request.headers.get('host') !== new URL(origin).host) return refuse(403);
      if (url.pathname !== BROWSER_COORDINATOR_PATHS[operation] || url.search) return refuse(400);
      const method = operation === 'observe' ? 'GET' : 'POST';
      if (request.method !== method) return refuse(405);
      const claimedOrigin = request.headers.get('origin');
      const site = request.headers.get('sec-fetch-site');
      if (
        (claimedOrigin !== null && claimedOrigin !== origin) ||
        (method === 'POST' && claimedOrigin !== origin) ||
        (site !== null && site !== 'same-origin')
      )
        return refuse(403);
      if (rateLimit(request, operation)) return refuse(429);
      if (request.signal.aborted) return refuse();
      if (operation === 'initialize') await emptyObject(request);
      const header = request.headers.get('cookie');
      const selected = await readSelection(header);
      if (request.signal.aborted) return refuse();
      if (selected.status === 'admitted' || selected.status === 'anonymous')
        return response({
          status: 'ready',
          cursor: { bindingId: selected.cursor.bindingId, version: selected.cursor.version },
        });
      if (selected.status !== 'missing-binding')
        return response(
          {
            status:
              selected.status === 'proof-required'
                ? 'proof-required'
                : selected.status === 'unavailable'
                  ? 'unavailable'
                  : 'conflict',
          },
          selected.status === 'unavailable' ? 503 : 409,
        );
      const legacy = missingCookies(header);
      if (operation === 'observe') return response({ status: 'missing-binding' });
      // A refused or unavailable actual legacy account cannot be shadowed by a
      // new anonymous selection. No header or body can supply its credential.
      let expiry: number | null = null;
      let userId: string | null = null;
      if (legacy !== null) {
        userId = await admitLegacy(legacy);
        if (!userId) return refuse(409, 'conflict');
        expiry = await legacyExpiry(legacy);
        if (expiry === null || expiry <= Date.now()) return refuse(409, 'conflict');
      }
      if (request.signal.aborted) return refuse();
      const client = clientFactory();
      const created = await client.bootstrap({});
      if (created.outcome !== 'created' || request.signal.aborted) return refuse();
      const bindingId = createHash('sha256').update(created.token).digest('hex');
      if (created.cursor.bindingId !== bindingId || created.cursor.version !== 0) return refuse();
      const correlation = buildCanonicalCoordinatorCorrelationCookie({
        servingOrigin: origin,
        canonicalOrigin: origin,
        token: created.token,
        bindingId,
      });
      const cursor = { bindingId, version: legacy === null ? 0 : 1 };
      // Include correlation in the projected *whole* next-request capacity.
      const projectedHeader = [header, correlation.split(';', 1)[0]].filter(Boolean).join('; ');
      const projectedPairs = projectedHeader.split(';').length;
      if (
        Buffer.byteLength(projectedHeader) > BROWSER_PROOF_COOKIE_LIMITS.projectedCookieHeaderBytes ||
        projectedPairs > BROWSER_PROOF_COOKIE_LIMITS.incomingPairs
      )
        return refuse();
      if (legacy === null) return response({ status: 'ready', cursor }, 200, [correlation]);
      const bindingExpiry = Date.parse(created.cursor.bindingExpiresAt);
      const maxAge = Math.floor((Math.min(expiry!, bindingExpiry) - Date.now()) / 1_000);
      const proof = buildBrowserProofCookieCandidate({
        cursor,
        proof: { kind: 'legacy-jwe', rawCredential: legacy },
        proofMaxAgeSeconds: maxAge,
        observedCookieHeader: projectedHeader,
        responseHeaderBudgetBytes: 32_768 - Buffer.byteLength(`Set-Cookie: ${correlation}\r\n`),
      });
      if (projectedPairs + proof.proofHeaders.length > BROWSER_PROOF_COOKIE_LIMITS.incomingPairs) return refuse();
      const buffered = response({ status: 'ready', cursor }, 200, [correlation, ...proof.headers]);
      const intent = await client.intent({ bindingToken: created.token, transition: 'login', expectedVersion: 0 });
      if (
        intent.outcome !== 'prepared' ||
        intent.cursor.bindingId !== bindingId ||
        intent.cursor.version !== 0 ||
        request.signal.aborted
      )
        return refuse();
      const committed = await client.login({
        bindingToken: created.token,
        intentToken: intent.intentToken,
        candidate: { kind: 'legacy-jwe', credential: legacy },
      });
      if (
        (committed.outcome !== 'committed' && committed.outcome !== 'already-committed') ||
        committed.cursor.bindingId !== bindingId ||
        committed.cursor.version !== 1 ||
        committed.cursor.bindingExpiresAt !== created.cursor.bindingExpiresAt ||
        committed.session?.userId !== userId ||
        Date.parse(committed.session.expiresAt) > expiry! ||
        request.signal.aborted
      )
        return refuse();
      return buffered;
    } catch (error) {
      return response(
        { status: error instanceof Refusal ? error.outcome : 'unavailable' },
        error instanceof Refusal ? error.status : 503,
      );
    }
  }
  return {
    observe: (request: Request) => run(request, 'observe'),
    initialize: (request: Request) => run(request, 'initialize'),
  };
}
