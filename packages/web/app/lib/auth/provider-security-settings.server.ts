import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  providerSecurityMode,
  providerSecurityReplyStatus,
  type ProviderSecurityReply,
} from '@boardsesh/auth-protocol';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';
import { resolvePublicAuthOrigin } from './canonical-auth-url';
import { readPresentedBrowserSelection, type PresentedBrowserSelection } from './presented-browser-selection.server';
import {
  createProviderSecurityCommandClient,
  type ProviderSecurityCommandClient,
} from './provider-security-command-client.server';
import {
  assertProviderSecurityFlowSecret,
  openProviderSecurityFlow,
  providerSecurityFlowCookieName,
  providerSecurityOperationKey,
  sealProviderSecurityFlow,
  type ProviderSecurityFlow,
} from './provider-security-flow.server';
import { publicProviderSecurityReady } from './provider-security-readiness';
import { createProviderSecurityDirectPublication } from './provider-security-direct.server';
import { checkRateLimit } from './rate-limiter';
import { providerSecurityResumeSchema } from './provider-security-resume';
import {
  providerSettingsViewFrame,
  PROVIDER_SETTINGS_VIEW_HEADER,
  PROVIDER_SETTINGS_OPERATION_HEADER,
} from './provider-security-view';
import {
  captureProviderBrowserContext,
  ProviderSecurityIdentityChangedError,
  requireProviderSecurityFlowActor,
  type ProviderBrowserContext,
} from './provider-security-selection.server';

export const PROVIDER_SETTINGS_PATHS = Object.freeze({
  methods: '/api/internal/auth/provider-security/methods',
  resume: '/api/internal/auth/provider-security/resume',
  intent: '/api/internal/auth/provider-security/intent',
  password: '/api/internal/auth/provider-security/reauthenticate-password',
  unlink: '/api/internal/auth/provider-security/unlink',
  acknowledge: '/api/internal/auth/provider-security/acknowledge',
});
const MAX_BODY_BYTES = 65_536;
const MAX_COOKIE_HEADER_BYTES = 32_768;
const MAX_COOKIE_PAIRS = 128;
const MAX_PENDING_OPERATIONS = 4;
const BODY_DEADLINE_MS = 5_000;
const operationKeySchema = z.string().regex(/^[a-f0-9]{64}$/);
const actorContextKey = operationKeySchema;
const intentInput = z.discriminatedUnion('action', [
  z.object({ actorContextKey, action: z.literal('link'), provider: z.enum(['google', 'apple']) }).strict(),
  z
    .object({
      actorContextKey,
      action: z.literal('unlink'),
      provider: z.enum(['google', 'apple']),
      methodId: operationKeySchema,
    })
    .strict(),
]);
const passwordInput = z
  .object({ actorContextKey, operationKey: operationKeySchema, password: z.string().min(1).max(16_384) })
  .strict();
const unlinkInput = z.object({ actorContextKey, operationKey: operationKeySchema }).strict();
const acknowledgeInput = z.object({ operationKey: operationKeySchema }).strict();

class Refusal extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 409 | 429 | 503,
    readonly outcome: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(outcome);
  }
}
function refuse(status: Refusal['status'], outcome: string, retryAfterSeconds?: number): never {
  throw new Refusal(status, outcome, retryAfterSeconds);
}
function response(body: unknown, status = 200, cookie?: string): Response {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > 131_072) return response({ outcome: 'unavailable' }, 503);
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, private',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (status === 503) headers.set('Retry-After', '1');
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(encoded, { status, headers });
}
function failure(reply: ProviderSecurityReply): never {
  const status = providerSecurityReplyStatus(reply);
  if (status === 200) return refuse(503, 'unavailable');
  if (reply.outcome === 'denied') {
    if (reply.code === 'last_usable_method' || reply.code === 'ownership_conflict') return refuse(status, reply.code);
    return refuse(status, 'denied');
  }
  return refuse(status, reply.outcome);
}
function cookiePairs(header: string | null): readonly { name: string; content: string }[] {
  if (header === null || header === '') return [];
  if (Buffer.byteLength(header) > MAX_COOKIE_HEADER_BYTES) return refuse(400, 'invalid_request');
  for (let index = 0; index < header.length; index++) {
    const code = header.charCodeAt(index);
    if ((code < 32 && code !== 9) || code === 127) return refuse(400, 'invalid_request');
  }
  const pieces = header.split(';');
  if (pieces.length > MAX_COOKIE_PAIRS) return refuse(400, 'invalid_request');
  return pieces
    .filter((piece) => piece.trim())
    .map((piece) => {
      const separator = piece.indexOf('=');
      return {
        name: (separator < 0 ? piece : piece.slice(0, separator)).trim(),
        content: separator < 0 ? '' : piece.slice(separator + 1).trim(),
      };
    });
}
async function readJson(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    return refuse(400, 'invalid_request');
  if (request.headers.has('content-encoding')) return refuse(400, 'invalid_request');
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_BODY_BYTES))
    return refuse(400, 'invalid_request');
  if (!request.body) return refuse(400, 'invalid_request');
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectInterrupted: (() => void) | undefined;
  let wasInterrupted = false;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = () => {
      wasInterrupted = true;
      reject(new Refusal(400, 'invalid_request'));
      void reader.cancel().catch(() => {});
    };
    timer = setTimeout(rejectInterrupted, BODY_DEADLINE_MS);
  });
  const onAbort = () => rejectInterrupted?.();
  request.signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (request.signal.aborted) return refuse(400, 'invalid_request');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let length = 0;
    let text = '';
    while (true) {
      const chunk = await Promise.race([reader.read(), interrupted]);
      if (wasInterrupted) return refuse(400, 'invalid_request');
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return refuse(400, 'invalid_request');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    if (wasInterrupted || request.signal.aborted || (declared !== null && Number(declared) !== length))
      return refuse(400, 'invalid_request');
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch {
    return refuse(400, 'invalid_request');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    request.signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/** A public BFF boundary, not a credential issuer. Production readiness is
 * code-owned and false; tests may supply a private server-only dependency. */
export function createProviderSecuritySettingsBroker(
  options: {
    readonly environment?: AuthServiceEnvironment;
    readonly ready?: () => boolean;
    readonly readSelection?: (cookieHeader: string | null) => Promise<PresentedBrowserSelection>;
    readonly clientFactory?: () => ProviderSecurityCommandClient;
    readonly clock?: () => Date;
    readonly rateLimit?: typeof checkRateLimit;
    readonly directPublicationFactory?: () => Pick<
      ReturnType<typeof createProviderSecurityDirectPublication>,
      'unlink' | 'acknowledge'
    >;
  } = {},
) {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const ready = options.ready ?? publicProviderSecurityReady;
  const readSelection = options.readSelection ?? ((cookies) => readPresentedBrowserSelection(cookies, { environment }));
  const clientFactory = options.clientFactory ?? (() => createProviderSecurityCommandClient({ environment }));
  const clock = options.clock ?? (() => new Date());
  const rateLimit = options.rateLimit ?? checkRateLimit;
  const directPublicationFactory =
    options.directPublicationFactory ??
    (() => createProviderSecurityDirectPublication({ environment, ready, readSelection, clientFactory }));
  function checkAttempt(current: ProviderBrowserContext, operation: 'intent' | 'password'): void {
    // Only a primary-admitted account selects the bucket. Proxy addresses and
    // caller-provided identity claims cannot lock out unrelated accounts.
    const limited = rateLimit(
      `provider-security:${operation}:${current.sourceCredentialProof.userId}`,
      operation === 'password' ? 5 : 10,
      60_000,
    );
    if (limited.limited) refuse(429, 'unavailable', limited.retryAfterSeconds);
  }

  async function admit(cookies: string | null, expected?: string): Promise<ProviderBrowserContext> {
    const selected = await readSelection(cookies);
    if (selected.status === 'unavailable') return refuse(503, 'unavailable');
    if (selected.status === 'conflict') return refuse(409, 'identity_changed');
    if (selected.status !== 'admitted') return refuse(401, 'unauthenticated');
    const current = captureProviderBrowserContext(selected, clock());
    if (expected !== undefined && current.actorContextKey !== expected) return refuse(409, 'identity_changed');
    return current;
  }
  async function revalidate(cookies: string | null, before: ProviderBrowserContext): Promise<void> {
    const current = await admit(cookies, before.actorContextKey);
    if (
      current.credentialExpiresAt !== before.credentialExpiresAt ||
      current.browserCursor.bindingExpiresAt !== before.browserCursor.bindingExpiresAt ||
      JSON.stringify(current.sourceCredentialProof) !== JSON.stringify(before.sourceCredentialProof)
    )
      return refuse(409, 'identity_changed');
  }
  async function run(request: Request, operation: keyof typeof PROVIDER_SETTINGS_PATHS): Promise<Response> {
    try {
      if (
        !ready() ||
        providerSecurityMode(environment) !== 'backend-staging' ||
        browserBindingMode(environment) !== 'backend-staging'
      )
        return refuse(503, 'unavailable');
      const url = new URL(request.url);
      const origin = resolvePublicAuthOrigin(environment);
      // The standalone server may report its internal HTTP bind address. Only
      // fixed canonical config plus the exact Host/Origin authorizes this BFF;
      // forwarded headers and the request URL never nominate an auth origin.
      if (!origin || new URL(origin).protocol !== 'https:') return refuse(503, 'unavailable');
      if (request.headers.get('host') !== new URL(origin).host) return refuse(403, 'invalid_request');
      if (url.pathname !== PROVIDER_SETTINGS_PATHS[operation] || url.search !== '')
        return refuse(400, 'invalid_request');
      const method = operation === 'methods' || operation === 'resume' ? 'GET' : 'POST';
      if (request.method !== method) return refuse(400, 'invalid_request');
      const claimedOrigin = request.headers.get('origin');
      const fetchSite = request.headers.get('sec-fetch-site');
      if (
        (claimedOrigin !== null && claimedOrigin !== origin) ||
        (method === 'POST' && claimedOrigin !== origin) ||
        (fetchSite !== null && fetchSite !== 'same-origin' && !(method === 'GET' && fetchSite === 'none'))
      )
        return refuse(403, 'invalid_request');
      const cookies = request.headers.get('cookie');
      const pairs = cookiePairs(cookies);
      if (operation === 'methods' || operation === 'resume') {
        const current = await admit(cookies);
        const expectedView = operationKeySchema.parse(request.headers.get(PROVIDER_SETTINGS_VIEW_HEADER));
        const actualView = createHash('sha256')
          .update(
            providerSettingsViewFrame({
              userId: current.actor.expectedUserId,
              authSessionId: current.actor.expectedAuthSessionId,
              generation: current.sourceCredentialProof.generation,
              cursor: { bindingId: current.browserCursor.bindingId, version: current.browserCursor.version },
            }),
          )
          .digest('hex');
        if (expectedView !== actualView) return refuse(409, 'identity_changed');
        if (operation === 'resume') {
          const operationKey = operationKeySchema.parse(request.headers.get(PROVIDER_SETTINGS_OPERATION_HEADER));
          const cookieName = providerSecurityFlowCookieName(operationKey, true);
          const matches = pairs.filter((pair) => pair.name === cookieName);
          if (matches.length !== 1) return refuse(409, 'identity_changed');
          const flow = await openProviderSecurityFlow(
            matches[0].content,
            operationKey,
            environment.NEXTAUTH_SECRET ?? '',
            clock(),
          );
          requireProviderSecurityFlowActor(flow, current);
          await revalidate(cookies, current);
          if (request.signal.aborted) return refuse(503, 'unavailable');
          return response(
            providerSecurityResumeSchema.parse({
              providerSecurityResumeVersion: 1,
              outcome: 'resumable',
              operationKey,
              actorContextKey: current.actorContextKey,
              action: flow.action,
              provider: flow.provider,
              methodId: flow.methodId,
              reauthenticationReady:
                flow.reauthenticationToken !== null &&
                flow.reauthenticationExpiresAt !== null &&
                Date.parse(flow.reauthenticationExpiresAt) > clock().getTime(),
            }),
          );
        }
        const reply = await clientFactory().command('methods', { actor: current.actor });
        if (reply.outcome !== 'available') return failure(reply);
        await revalidate(cookies, current);
        if (request.signal.aborted) return refuse(503, 'unavailable');
        return response({
          outcome: 'available',
          actorContextKey: current.actorContextKey,
          methods: reply.providers,
          configuredProviders: reply.configuredProviders,
          passwordUsable: reply.passwordUsable,
          googleReauthenticationAvailable: reply.googleReauthenticationAvailable,
        });
      }
      const input: unknown = await readJson(request);
      if (operation === 'unlink') {
        const command = unlinkInput.parse(input);
        return await directPublicationFactory().unlink({
          cookieHeader: cookies,
          operationKey: command.operationKey,
          actorContextKey: command.actorContextKey,
          signal: request.signal,
        });
      }
      if (operation === 'acknowledge') {
        const command = acknowledgeInput.parse(input);
        return await directPublicationFactory().acknowledge({
          cookieHeader: cookies,
          operationKey: command.operationKey,
          signal: request.signal,
        });
      }
      if (operation === 'intent') {
        const command = intentInput.parse(input);
        assertProviderSecurityFlowSecret(environment.NEXTAUTH_SECRET ?? '');
        const current = await admit(cookies, command.actorContextKey);
        if (
          pairs.filter((pair) => pair.name.startsWith('__Host-boardsesh.provider-security.')).length >=
          MAX_PENDING_OPERATIONS
        )
          return refuse(409, 'unavailable');
        checkAttempt(current, 'intent');
        const reply = await clientFactory().command('intent', {
          actor: current.actor,
          action: command.action,
          provider: command.provider,
          methodId: command.action === 'link' ? null : command.methodId,
        });
        if (reply.outcome !== 'recorded') return failure(reply);
        if (
          reply.browserCursor.bindingId !== current.browserCursor.bindingId ||
          reply.browserCursor.version !== current.browserCursor.version ||
          reply.browserCursor.bindingExpiresAt !== current.browserCursor.bindingExpiresAt
        )
          return refuse(503, 'unavailable');
        const issuedAt = clock();
        const expiresAt = new Date(
          Math.min(
            Date.parse(reply.expiresAt),
            issuedAt.getTime() + 15 * 60_000,
            Date.parse(current.credentialExpiresAt),
            Date.parse(current.browserCursor.bindingExpiresAt),
          ),
        );
        const flow: ProviderSecurityFlow = {
          version: 1,
          action: command.action,
          provider: command.provider,
          methodId: command.action === 'link' ? null : command.methodId,
          actorKind: current.actor.kind,
          actorCredentialHash: current.credentialHash,
          browserBindingHash: current.browserCursor.bindingId,
          browserVersion: current.browserCursor.version,
          browserBindingExpiresAt: current.browserCursor.bindingExpiresAt,
          sourceCredentialProof: { ...current.sourceCredentialProof },
          credentialExpiresAt: current.credentialExpiresAt,
          intentToken: reply.intentToken,
          browserIntentToken: reply.browserIntentToken,
          recoveryToken: reply.recoveryToken,
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          reauthenticationToken: null,
          reauthenticationExpiresAt: null,
          providerFlowHash: null,
          googleFlowHash: null,
          googleNonce: null,
        };
        const operationKey = providerSecurityOperationKey(flow.intentToken);
        const sealed = await sealProviderSecurityFlow(flow, environment.NEXTAUTH_SECRET ?? '', clock());
        await revalidate(cookies, current);
        if (request.signal.aborted) return refuse(503, 'unavailable');
        return response(
          { outcome: 'reauthentication_required', operationKey },
          200,
          flowCookie(operationKey, sealed, flow.expiresAt),
        );
      }
      const command = passwordInput.parse(input);
      const current = await admit(cookies, command.actorContextKey);
      const cookieName = providerSecurityFlowCookieName(command.operationKey, true);
      const matches = pairs.filter((pair) => pair.name === cookieName);
      if (matches.length !== 1) return refuse(400, 'invalid_request');
      const flow = await openProviderSecurityFlow(
        matches[0].content,
        command.operationKey,
        environment.NEXTAUTH_SECRET ?? '',
        clock(),
      );
      requireProviderSecurityFlowActor(flow, current);
      checkAttempt(current, 'password');
      const reply = await clientFactory().command('reauthenticate-password', {
        actor: current.actor,
        intentToken: flow.intentToken,
        browserIntentToken: flow.browserIntentToken,
        password: command.password,
      });
      if (reply.outcome !== 'proved') return failure(reply);
      const nextFlow = {
        ...flow,
        reauthenticationToken: reply.reauthenticationToken,
        reauthenticationExpiresAt: new Date(
          Math.min(Date.parse(reply.expiresAt), Date.parse(flow.expiresAt)),
        ).toISOString(),
      };
      const sealed = await sealProviderSecurityFlow(nextFlow, environment.NEXTAUTH_SECRET ?? '', clock());
      await revalidate(cookies, current);
      if (request.signal.aborted) return refuse(503, 'unavailable');
      return response(
        { outcome: 'completed', operationKey: command.operationKey },
        200,
        flowCookie(command.operationKey, sealed, flow.expiresAt),
      );
    } catch (error) {
      if (error instanceof Refusal) {
        const refused = response({ outcome: error.outcome }, error.status);
        if (error.status === 429) refused.headers.set('Retry-After', String(Math.max(1, error.retryAfterSeconds ?? 1)));
        return refused;
      }
      if (error instanceof ProviderSecurityIdentityChangedError) return response({ outcome: 'identity_changed' }, 409);
      if (error instanceof z.ZodError) return response({ outcome: 'invalid_request' }, 400);
      return response({ outcome: 'unavailable' }, 503);
    }
  }
  function flowCookie(operationKey: string, sealed: string, expiresAt: string): string {
    return `${providerSecurityFlowCookieName(operationKey, true)}=${sealed}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`;
  }
  return Object.freeze({
    methods: (request: Request) => run(request, 'methods'),
    resume: (request: Request) => run(request, 'resume'),
    intent: (request: Request) => run(request, 'intent'),
    reauthenticatePassword: (request: Request) => run(request, 'password'),
    unlink: (request: Request) => run(request, 'unlink'),
    acknowledge: (request: Request) => run(request, 'acknowledge'),
  });
}
