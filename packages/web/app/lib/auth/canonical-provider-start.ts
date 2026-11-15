import {
  BROWSER_COORDINATOR_LOCK,
  BROWSER_COORDINATOR_PUBLIC_PATHS,
  browserBindingCursorSchema,
  browserCoordinatorObservationSchema,
  type BrowserBindingCursor,
} from '@boardsesh/auth-protocol/browser-coordinator';
import { acknowledgeProviderSignin } from './provider-signin-acknowledgment';

interface ProviderStartLocks {
  request(
    name: string,
    options: { mode: 'exclusive'; signal: AbortSignal },
    invoke: () => Promise<void>,
  ): Promise<void>;
}
const unavailable = (): never => {
  throw new Error('PROVIDER_SIGNIN_UNAVAILABLE');
};
async function settledJson(response: Response, maximumBytes = 16_384): Promise<unknown> {
  if (!response.body) return unavailable();
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        return unavailable();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) return unavailable();
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
}

/** Canonical WWW only. Preflight finishes before the parent lock is acquired;
 * the lock then spans every physical fetch/body settlement before navigation. */
export async function startCanonicalProviderSignin(
  input: {
    readonly canonicalOrigin: string;
    readonly provider: 'google' | 'apple';
    readonly callbackUrl: string;
    readonly signal: AbortSignal;
    readonly operation?: Readonly<{ purpose: 'link' | 'reauthenticate-google'; operationKey: string }>;
  },
  dependencies: {
    readonly currentOrigin: string;
    readonly locks: ProviderStartLocks | undefined;
    readonly preflight: (origin: string, signal: AbortSignal) => Promise<BrowserBindingCursor | void>;
    readonly send: typeof fetch;
    readonly beforeSignin?: () => Promise<void>;
    readonly navigate: (destination: string) => void;
  },
): Promise<void> {
  const canonicalOrigin = input.canonicalOrigin;
  const provider = input.provider;
  const callbackUrl = input.callbackUrl;
  const signal = input.signal;
  const operation = input.operation ? Object.freeze({ ...input.operation }) : undefined;
  const preflight = dependencies.preflight;
  const send = dependencies.send;
  const beforeSignin = dependencies.beforeSignin;
  const navigate = dependencies.navigate;
  const origin = new URL(canonicalOrigin);
  if (
    origin.protocol !== 'https:' ||
    canonicalOrigin !== origin.origin ||
    dependencies.currentOrigin !== canonicalOrigin ||
    !dependencies.locks ||
    (provider !== 'google' && provider !== 'apple') ||
    callbackUrl.length > 4096 ||
    signal.aborted
  )
    return unavailable();
  const callback = new URL(callbackUrl, canonicalOrigin);
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash) return unavailable();
  if (
    operation &&
    (!/^[a-f0-9]{64}$/.test(operation.operationKey) ||
      (operation.purpose !== 'link' && operation.purpose !== 'reauthenticate-google') ||
      (operation.purpose === 'reauthenticate-google' && provider !== 'google') ||
      callback.origin !== canonicalOrigin ||
      !/^\/(?:(?:es|fr|de|it)\/)?settings$/.test(callback.pathname) ||
      callback.searchParams.getAll('providerSecurityResume').length !== 1 ||
      callback.searchParams.get('providerSecurityResume') !== operation.operationKey ||
      [...callback.searchParams.keys()].length !== 1)
  )
    return unavailable();
  const requestLock = dependencies.locks.request.bind(dependencies.locks);
  // The frame itself takes the same canonical-origin lock. Holding it here
  // while awaiting frame preflight would deadlock the two documents.
  const observed = await preflight(canonicalOrigin, signal);
  if (signal.aborted) return unavailable();
  const pinned = operation ? null : browserBindingCursorSchema.parse(observed);
  let destination: string | undefined;
  await requestLock(BROWSER_COORDINATOR_LOCK, { mode: 'exclusive', signal }, async () => {
    if (signal.aborted) return unavailable();
    if (pinned) {
      // The frame released this same-name lock before we acquired it. Observe
      // directly here so an intervening selection cannot adopt an old click.
      const response = await send(`${canonicalOrigin}${BROWSER_COORDINATOR_PUBLIC_PATHS.observe}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive: false,
        redirect: 'error',
        signal,
      });
      const current = browserCoordinatorObservationSchema.parse(await settledJson(response, 8_192));
      if (
        response.status !== 200 ||
        current.status !== 'ready' ||
        signal.aborted ||
        current.cursor.bindingId !== pinned.bindingId ||
        current.cursor.version !== pinned.version
      )
        return unavailable();
    }
    const acknowledged = await acknowledgeProviderSignin(canonicalOrigin, signal, send);
    if ((acknowledged !== 'none' && acknowledged !== 'recovered') || signal.aborted) return unavailable();
    await beforeSignin?.();
    if (signal.aborted) return unavailable();
    const csrfResponse = await send(`${canonicalOrigin}/api/auth/csrf`, {
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: false,
      redirect: 'error',
      signal,
    });
    const csrf = await settledJson(csrfResponse);
    if (
      !csrfResponse.ok ||
      !csrf ||
      typeof csrf !== 'object' ||
      Array.isArray(csrf) ||
      Object.keys(csrf).length !== 1 ||
      !('csrfToken' in csrf) ||
      typeof csrf.csrfToken !== 'string' ||
      !csrf.csrfToken ||
      csrf.csrfToken.length > 1024 ||
      signal.aborted
    )
      return unavailable();
    const response = await send(`${canonicalOrigin}/api/auth/signin/${provider}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: false,
      redirect: 'error',
      signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        csrfToken: csrf.csrfToken,
        callbackUrl: callback.href,
        json: 'true',
        ...(operation
          ? { providerSecurityOperation: operation.purpose, providerSecurityOperationKey: operation.operationKey }
          : {}),
      }),
    });
    const reply = await settledJson(response);
    if (
      !response.ok ||
      !reply ||
      typeof reply !== 'object' ||
      Array.isArray(reply) ||
      Object.keys(reply).length !== 1 ||
      !('url' in reply) ||
      typeof reply.url !== 'string' ||
      signal.aborted
    )
      return unavailable();
    const authorization = new URL(reply.url);
    const expectedHost = provider === 'google' ? 'accounts.google.com' : 'appleid.apple.com';
    const expectedPath = provider === 'google' ? '/o/oauth2/v2/auth' : '/auth/authorize';
    if (
      authorization.protocol !== 'https:' ||
      authorization.hostname !== expectedHost ||
      authorization.pathname !== expectedPath ||
      authorization.port ||
      authorization.username ||
      authorization.password ||
      authorization.hash ||
      authorization.href.length > 8192 ||
      authorization.searchParams.getAll('state').length !== 1 ||
      !authorization.searchParams.get('state')
    )
      return unavailable();
    destination = authorization.href;
  });
  if (!destination || signal.aborted) return unavailable();
  navigate(destination);
}
