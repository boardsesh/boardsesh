import {
  AUTH_BACKEND_UNAVAILABLE,
  AUTH_COMMAND_REQUEST_BYTES,
  AUTH_COMMAND_RESPONSE_BYTES,
  AUTH_COMMAND_TIMEOUT_MS,
} from './index';

export type AuthServiceEnvironment = Readonly<Record<string, string | undefined>>;

export class AuthBackendUnavailableError extends Error {
  constructor() {
    super(AUTH_BACKEND_UNAVAILABLE);
    this.name = 'AuthBackendUnavailableError';
  }
}

export function trustedAuthOrigin(configured: string, environment: AuthServiceEnvironment): string {
  const origin = new URL(configured);
  const ownedLocal =
    (environment.NODE_ENV === 'development' || environment.NODE_ENV === 'test') &&
    ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (
    configured !== configured.trim() ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ownedLocal))
  )
    throw new AuthBackendUnavailableError();
  return origin.origin;
}

/** Fixed private destinations and bounded I/O; each client owns its mode and DTO validation. */
export function createPrivateAuthCommandTransport(options: {
  paths: readonly string[];
  environment: AuthServiceEnvironment;
  fetch: typeof fetch;
  originKey: string;
  secretKey: string;
  disallowedSecretKeys: readonly string[];
  timeoutMs?: number;
}) {
  const environment = options.environment;
  const paths = new Set(options.paths);
  let origin: string;
  let secret: string;
  try {
    origin = trustedAuthOrigin(environment[options.originKey] ?? '', environment);
    secret = environment[options.secretKey] ?? '';
    if (
      secret.trim() !== secret ||
      new TextEncoder().encode(secret).byteLength < 32 ||
      options.disallowedSecretKeys.some((name) => Boolean(environment[name]) && secret === environment[name])
    )
      throw new AuthBackendUnavailableError();
  } catch {
    throw new AuthBackendUnavailableError();
  }
  const send = options.fetch;
  const timeoutMs = options.timeoutMs ?? AUTH_COMMAND_TIMEOUT_MS;

  return {
    async post(path: string, command: unknown): Promise<{ status: number; body: unknown }> {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        if (!paths.has(path)) throw new AuthBackendUnavailableError();
        const body = JSON.stringify(command);
        if (typeof body !== 'string' || new TextEncoder().encode(body).byteLength > AUTH_COMMAND_REQUEST_BYTES)
          throw new AuthBackendUnavailableError();
        const operation = async () => {
          const response = await send(`${origin}${path}`, {
            method: 'POST',
            redirect: 'error',
            cache: 'no-store',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body,
          });
          if (
            response.redirected ||
            !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '') ||
            !response.body
          )
            throw new AuthBackendUnavailableError();
          const contentLength = response.headers.get('Content-Length');
          if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > AUTH_COMMAND_RESPONSE_BYTES))
            throw new AuthBackendUnavailableError();
          reader = response.body.getReader();
          const decoder = new TextDecoder('utf-8', { fatal: true });
          let length = 0;
          let json = '';
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > AUTH_COMMAND_RESPONSE_BYTES) throw new AuthBackendUnavailableError();
            json += decoder.decode(chunk.value, { stream: true });
          }
          json += decoder.decode();
          return { status: response.status, body: JSON.parse(json) as unknown };
        };
        return await Promise.race([
          operation(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new AuthBackendUnavailableError());
            }, timeoutMs);
          }),
        ]);
      } catch {
        // Do not retain submitted credentials, provider bodies, URLs or nested causes.
        throw new AuthBackendUnavailableError();
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
        void reader?.cancel().catch(() => undefined);
      }
    },
  };
}
