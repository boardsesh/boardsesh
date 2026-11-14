import { BROWSER_COORDINATOR_LOCK } from '@boardsesh/auth-protocol/browser-coordinator';
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
async function settledJson(response: Response): Promise<unknown> {
  if (!response.body) return unavailable();
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16_384) {
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
  },
  dependencies: {
    readonly currentOrigin: string;
    readonly locks: ProviderStartLocks | undefined;
    readonly preflight: (origin: string, signal: AbortSignal) => Promise<void>;
    readonly send: typeof fetch;
    readonly beforeSignin?: () => Promise<void>;
    readonly navigate: (destination: string) => void;
  },
): Promise<void> {
  const canonicalOrigin = input.canonicalOrigin;
  const provider = input.provider;
  const callbackUrl = input.callbackUrl;
  const signal = input.signal;
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
  const requestLock = dependencies.locks.request.bind(dependencies.locks);
  // The frame itself takes the same canonical-origin lock. Holding it here
  // while awaiting frame preflight would deadlock the two documents.
  await preflight(canonicalOrigin, signal);
  if (signal.aborted) return unavailable();
  let destination: string | undefined;
  await requestLock(BROWSER_COORDINATOR_LOCK, { mode: 'exclusive', signal }, async () => {
    if (signal.aborted) return unavailable();
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
      body: new URLSearchParams({ csrfToken: csrf.csrfToken, callbackUrl: callback.href, json: 'true' }),
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
