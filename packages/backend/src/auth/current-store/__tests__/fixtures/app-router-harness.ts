import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ConfiguredIdentity, ConfiguredProvider, ConfiguredProviderFaults } from './app-router-providers';

function bounded<T>(pending: Promise<T>, milliseconds = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    pending,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Owned App Router deadline')), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}
export interface BridgeResponse {
  status: number;
  location: string | undefined;
  cookies: string[];
  body: string;
}
export async function startAppRouterHarness(options: {
  databaseUrl: string;
  nextAuthSecret?: string;
  compound?: { origin: string; secret: string };
  webOAuthIdentity?: { origin: string; secret: string };
  faults?: {
    failEvent?: boolean;
    failEncode?: boolean;
    pauseBeforeEncode?: boolean;
    discardConflictResponse?: boolean;
    discardSuccessfulCompoundResponse?: boolean;
    discardSuccessfulWebOAuthResponse?: boolean;
  };
  browserIdentity?: ConfiguredIdentity;
  sessionPublicationProof?: boolean;
}) {
  const require = createRequire(import.meta.url);
  const secret = options.nextAuthSecret ?? randomBytes(32).toString('base64url');
  const processHandle = spawn(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--conditions=react-server',
      '--import',
      require.resolve('tsx'),
      fileURLToPath(new URL('./app-router-probe.ts', import.meta.url)),
    ],
    {
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../../../web/tsconfig.json', import.meta.url)),
        DATABASE_URL: 'postgresql://owned:unused@127.0.0.1:1/unused',
        READ_REPLICA_URL: 'postgresql://owned:unused@127.0.0.1:1/unused',
        // The probe loads the backend's GraphQL server and then the web's auth
        // routes into one process, which no deployment does. The backend's
        // shared pool is built first, so the web's applyRequestPoolDefaults()
        // would refuse to run; 0 says this process sends no idle timeout.
        DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0',
      },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  const messages: Record<string, unknown>[] = [];
  const listeners = new Set<() => void>();
  let exited = false;
  const completion = new Promise<void>((resolve, reject) => {
    processHandle.once('error', () => {
      exited = true;
      reject(new Error('Owned App Router child failed'));
      for (const listener of listeners) listener();
    });
    processHandle.on('message', (input: unknown) => {
      if (input && typeof input === 'object' && !Array.isArray(input)) messages.push(input as Record<string, unknown>);
      for (const listener of listeners) listener();
    });
    processHandle.once('exit', (code) => {
      exited = true;
      if (code === 0) resolve();
      else reject(new Error('Owned App Router child failed'));
      for (const listener of listeners) listener();
    });
  });
  void completion.catch(() => {});
  async function wait(predicate: (message: Record<string, unknown>) => boolean) {
    let wake = () => {};
    try {
      return await bounded(
        new Promise<Record<string, unknown>>((resolve, reject) => {
          wake = () => {
            const failure = messages.find((message) => message.kind === 'failure');
            if (failure) {
              reject(new Error(`Owned App Router failed during ${String(failure.phase)}`));
              return;
            }
            const found = messages.find(predicate);
            if (found) resolve(found);
            else if (exited) reject(new Error('Owned App Router ended before receipt'));
          };
          listeners.add(wake);
          wake();
        }),
      );
    } finally {
      listeners.delete(wake);
    }
  }
  async function call(action: string, parameters: Record<string, unknown> = {}) {
    const id = randomUUID();
    processHandle.send({ action, id, ...parameters });
    return (await wait((message) => message.kind === 'reply' && message.id === id)).result;
  }
  processHandle.send({
    databaseUrl: options.databaseUrl,
    secret,
    compound: options.compound,
    webOAuthIdentity: options.webOAuthIdentity,
    faults: options.faults,
    browserIdentity: options.browserIdentity,
    sessionPublicationProof: options.sessionPublicationProof,
  });
  let ready: Record<string, unknown>;
  try {
    ready = await wait((message) => message.kind === 'ready');
  } catch (error) {
    processHandle.kill('SIGKILL');
    await completion.catch(() => {});
    throw error;
  }
  if (
    typeof ready.origin !== 'string' ||
    !/^https:\/\/localhost:\d+$/.test(ready.origin) ||
    (options.sessionPublicationProof &&
      (typeof ready.peerOrigin !== 'string' ||
        !/^https:\/\/localhost:\d+$/.test(ready.peerOrigin) ||
        ready.peerOrigin === ready.origin))
  ) {
    processHandle.kill('SIGKILL');
    await completion.catch(() => {});
    throw new Error('Invalid owned App Router origin');
  }
  const origin = ready.origin;
  async function requestOwned(
    path: string,
    options: { method?: string; cookie?: string; form?: string; headers?: Record<string, string> } = {},
  ): Promise<BridgeResponse> {
    const destination = new URL(path, origin);
    if (destination.origin !== origin || destination.username || destination.password)
      throw new Error('Unowned App Router destination');
    return bounded(
      new Promise<BridgeResponse>((resolve, reject) => {
        const pending = request(
          destination,
          {
            rejectUnauthorized: false,
            hostname: '127.0.0.1',
            servername: 'localhost',
            method: options.method ?? 'GET',
            timeout: 8000,
            headers: {
              Host: destination.host,
              ...(options.cookie ? { Cookie: options.cookie } : {}),
              ...(options.form !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
              ...options.headers,
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let length = 0;
            response.on('data', (chunk: Buffer) => {
              length += chunk.length;
              if (length > 65536) response.destroy(new Error('Owned response cap'));
              else chunks.push(chunk);
            });
            response.once('error', () => reject(new Error('Owned App Router response failed')));
            response.once('end', () =>
              resolve({
                status: response.statusCode ?? 0,
                location: response.headers.location,
                cookies: response.headers['set-cookie'] ?? [],
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            );
          },
        );
        pending.once('error', () => reject(new Error('Owned App Router request failed')));
        pending.once('timeout', () => pending.destroy(new Error('Owned request timeout')));
        pending.end(options.form);
      }),
    );
  }
  return {
    origin,
    providerOrigin: String(ready.providerOrigin),
    peerOrigin: typeof ready.peerOrigin === 'string' ? ready.peerOrigin : undefined,
    request: requestOwned,
    call,
    waitEncodeCheckpoint: () => wait((message) => message.kind === 'encode-checkpoint'),
    async armSessionResponseGate() {
      const gateId = randomUUID();
      await call('arm-session-response', { gateId });
      return gateId;
    },
    waitSessionResponseGate: (gateId: string) =>
      wait((message) => message.kind === 'response-checkpoint' && message.gateId === gateId),
    releaseSessionResponseGate: (gateId: string) => call('release-session-response', { gateId }),
    async authorize(url: string, identity: ConfiguredIdentity, faults: ConfiguredProviderFaults = {}) {
      return (await call('authorize', { url, identity, faults })) as {
        provider: ConfiguredProvider;
        method: string;
        url: string;
        form: string;
      };
    },
    async close() {
      if (!exited) processHandle.send({ action: 'stop' });
      try {
        await bounded(completion, 12000);
      } catch (error) {
        processHandle.kill('SIGKILL');
        await completion.catch(() => {});
        throw error;
      }
    },
  };
}

export class RouteExportBrowser {
  readonly cookies = new Map<string, string>();
  constructor(readonly harness: Awaited<ReturnType<typeof startAppRouterHarness>>) {}
  header() {
    return [...this.cookies].map(([name, content]) => `${name}=${content}`).join('; ');
  }
  remember(response: BridgeResponse) {
    for (const header of response.cookies) {
      const [pair] = header.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      if (/max-age=0/i.test(header)) this.cookies.delete(name);
      else this.cookies.set(name, pair.slice(separator + 1));
    }
  }
  session() {
    const base = '__Secure-next-auth.session-token';
    return (
      this.cookies.get(base) ??
      [...this.cookies]
        .filter(([name]) => name.startsWith(`${base}.`))
        .sort(([first], [second]) => Number(first.split('.').at(-1)) - Number(second.split('.').at(-1)))
        .map(([, content]) => content)
        .join('')
    );
  }
  async request(path: string, options: { method?: string; form?: string; cookie?: string } = {}) {
    const result = await this.harness.request(path, { cookie: this.header(), ...options });
    this.remember(result);
    return result;
  }
  async start(provider: ConfiguredProvider, callbackUrl = `${this.harness.origin}/signed-in`) {
    const csrf = await this.request('/api/auth/csrf');
    const csrfToken = (JSON.parse(csrf.body) as { csrfToken: string }).csrfToken;
    const result = await this.request(`/api/auth/signin/${provider}`, {
      method: 'POST',
      form: new URLSearchParams({ csrfToken, callbackUrl }).toString(),
    });
    if (result.status !== 302 || !result.location) throw new Error('Owned provider start failed');
    return result.location;
  }
  async complete(
    provider: ConfiguredProvider,
    identity: ConfiguredIdentity,
    faults: ConfiguredProviderFaults = {},
    callbackUrl?: string,
  ) {
    const authorization = await this.start(provider, callbackUrl);
    const callback = await this.harness.authorize(authorization, identity, faults);
    let response = await this.request(callback.url, {
      method: callback.method,
      ...(callback.method === 'POST' ? { form: callback.form } : {}),
    });
    const handoff = response;
    if (response.status === 303 && response.location?.startsWith(`${this.harness.origin}/__proof/continue/`))
      response = await this.request(response.location);
    if (
      response.status === 303 &&
      response.location?.startsWith(`${this.harness.origin}/api/auth/callback/apple?boardseshOAuthContinue=`)
    )
      response = await this.request(response.location);
    return { response, authorization, callback, handoff };
  }
  async claims() {
    return (await this.harness.call('decode', { token: decodeURIComponent(this.session()) })) as Record<
      string,
      unknown
    > | null;
  }
}
