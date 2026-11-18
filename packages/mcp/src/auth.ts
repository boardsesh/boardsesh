import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { z } from 'zod';
import { readCredentials, removeCredentials, writeCredentials, type Credentials } from './credentials';
import { isProfileLocked, type ProfileLock } from './profile-lock';
import {
  API_ORIGIN,
  ISSUER,
  RESOURCE,
  SCOPES,
  McpError,
  PartnerError,
  type PartnerClient,
  type Profile,
  type ProfileStore,
} from './types';

export interface AuthOptions {
  dataDir: string;
  store: ProfileStore;
  guard: ProfileLock;
  fetch?: typeof fetch;
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.string().refine((tokenType) => tokenType.toLowerCase() === 'bearer'),
  scope: z.string().optional(),
});

function record(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

/** Cap even chunked responses; malformed response bodies never enter errors/logs. */
async function readJson(response: Response, maxBytes = 4 * 1024 * 1024): Promise<unknown> {
  if (!response.body) throw new McpError('invalid_response', 'Boardsesh returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > maxBytes) {
        await reader.cancel();
        throw new McpError('invalid_response', 'Boardsesh response exceeded the size limit.');
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError('invalid_response', 'Boardsesh returned an unreadable response.');
  } finally {
    reader.releaseLock();
  }
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(Math.min(seconds, 86400));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.ceil(Math.max(0, Math.min((date - Date.now()) / 1000, 86400))) : undefined;
}

async function refusal(response: Response): Promise<PartnerError> {
  const payload = await readJson(response, 65_536).catch(() => undefined);
  const code =
    record(payload) && typeof payload.error === 'string' && /^[a-z_]{1,80}$/.test(payload.error)
      ? payload.error
      : 'request_failed';
  return new PartnerError(
    response.status,
    code,
    `Boardsesh request failed (${response.status}, ${code}).`,
    retryAfter(response),
  );
}

async function fetchBounded(fetcher: typeof fetch, url: string, options: RequestInit = {}): Promise<Response> {
  try {
    return await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch (cause) {
    const error = new McpError(
      'network_unavailable',
      'Boardsesh could not be reached. Cached history is still available unless reconnection is required.',
    );
    Object.defineProperty(error, 'cause', { value: cause, enumerable: false });
    throw error;
  }
}

/** Only connection establishment failures prove the refresh request was never sent. */
function failedBeforeSend(error: unknown, depth = 0): boolean {
  if (!record(error) || depth > 5) return false;
  if (Array.isArray(error.errors)) {
    return error.errors.length > 0 && error.errors.every((entry) => failedBeforeSend(entry, depth + 1));
  }
  if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN' || error.code === 'UND_ERR_CONNECT_TIMEOUT') return true;
  if ((error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') && error.syscall === 'connect') return true;
  if (typeof error.code === 'string' && error.code !== 'network_unavailable') return false;
  return failedBeforeSend(error.cause, depth + 1);
}

async function revokeIssuedFamily(fetcher: typeof fetch, clientId: string, refreshToken: string): Promise<void> {
  try {
    const response = await fetchBounded(fetcher, `${ISSUER}/oauth2/revoke`, {
      method: 'POST',
      body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }),
    });
    await response.body?.cancel();
  } catch {
    // Best effort cleanup must never replace the original login error or expose tokens.
  }
}

function reconnect(options: AuthOptions, profile: Profile): never {
  options.guard.assertHeld();
  const current = options.store.getProfile();
  if (current?.generation === profile.generation) {
    options.store.setProfile({ ...current, authStatus: 'reconnect_required' });
  }
  throw new McpError('reconnect_required', 'Run boardsesh-mcp login to reconnect this profile.');
}

/** Run after opening the profile, including before offline-only tool calls. */
export async function recoverCredentialState(options: AuthOptions): Promise<void> {
  options.guard.assertHeld();
  const profile = options.store.getProfile();
  if (!profile || profile.authStatus !== 'connected') return;
  const credentials = await readCredentials(options.dataDir).catch(() => undefined);
  options.guard.assertHeld();
  if (options.store.getProfile()?.generation !== profile.generation) {
    throw new McpError('profile_changed', 'The local profile changed while checking credentials.');
  }
  if (
    !credentials ||
    credentials.refreshPending ||
    credentials.generation !== profile.generation ||
    credentials.clientId !== profile.clientId ||
    credentials.accountId !== profile.accountId ||
    credentials.issuer !== profile.issuer
  ) {
    options.store.setProfile({ ...profile, authStatus: 'reconnect_required' });
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still establishes that a process owns this PID. Local credentials
    // are already restricted to this OS user; this is crash detection, not an
    // authentication mechanism against other processes running as that user.
    return record(error) && error.code === 'EPERM';
  }
}

/**
 * Cached reads never wait for the network-held profile lock. Atomic credential
 * replacement and the generation recheck let the caller enter its synchronous
 * SQLite read transaction next. A live rotating request does not revoke local
 * history; an abandoned rotation does require reconnection.
 */
export async function assertCachedCredentials(options: Pick<AuthOptions, 'dataDir' | 'store'>): Promise<Profile> {
  const profile = options.store.getProfile();
  const fail = (): never => {
    throw new McpError('reconnect_required', 'Run boardsesh-mcp login to reconnect this profile.');
  };
  if (!profile || profile.authStatus !== 'connected') return fail();
  const credentials = await readCredentials(options.dataDir).catch(() => undefined);
  if (
    credentials?.refreshPending &&
    (!credentials.refreshOwnerPid ||
      !processIsAlive(credentials.refreshOwnerPid) ||
      !(await isProfileLocked(options.dataDir)))
  ) {
    return fail();
  }
  const current = options.store.getProfile();
  if (
    !current ||
    current.authStatus !== 'connected' ||
    current.generation !== profile.generation ||
    current.issuer !== profile.issuer ||
    current.clientId !== profile.clientId ||
    current.accountId !== profile.accountId ||
    !credentials ||
    credentials.generation !== current.generation ||
    credentials.clientId !== current.clientId ||
    credentials.accountId !== current.accountId ||
    credentials.issuer !== current.issuer
  ) {
    return fail();
  }
  return current;
}

/** The caller owns the cross-process profile lock for the entire request. */
export class ApiClient implements PartnerClient {
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: AuthOptions) {
    this.fetcher = options.fetch ?? fetch;
  }

  private current(profile: Profile): void {
    this.options.guard.assertHeld();
    this.options.store.assertProfile(profile.generation);
  }

  private async credentials(profile: Profile): Promise<Credentials> {
    this.current(profile);
    const credentials = await readCredentials(this.options.dataDir);
    this.current(profile);
    if (
      !credentials ||
      credentials.refreshPending ||
      credentials.generation !== profile.generation ||
      credentials.clientId !== profile.clientId ||
      credentials.accountId !== profile.accountId ||
      credentials.issuer !== profile.issuer
    ) {
      return reconnect(this.options, profile);
    }
    return credentials;
  }

  private async refresh(profile: Profile, credentials: Credentials): Promise<Credentials> {
    let resolved = false;
    try {
      this.current(profile);
      await writeCredentials(
        this.options.dataDir,
        { ...credentials, refreshPending: true, refreshOwnerPid: process.pid },
        this.options.guard,
      );
      let response: Response;
      try {
        response = await fetchBounded(this.fetcher, `${ISSUER}/oauth2/token`, {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: credentials.refreshToken,
            client_id: profile.clientId,
            resource: RESOURCE,
          }),
        });
      } catch (error) {
        if (!failedBeforeSend(error)) return reconnect(this.options, profile);
        this.current(profile);
        await writeCredentials(
          this.options.dataDir,
          { ...credentials, refreshOwnerPid: undefined },
          this.options.guard,
        );
        resolved = true;
        throw error;
      }
      this.current(profile);
      if (!response.ok) {
        const error = await refusal(response);
        if (error.code === 'invalid_grant') return reconnect(this.options, profile);
        // A server error can follow committed issuance. Only a known protocol
        // rejection or rate limit proves that retrying this family is safe.
        const rejectedWithoutIssuance =
          response.status === 429 ||
          ((response.status === 400 || response.status === 401) &&
            [
              'invalid_client',
              'invalid_request',
              'invalid_scope',
              'invalid_target',
              'unauthorized_client',
              'unsupported_grant_type',
            ].includes(error.code));
        if (!rejectedWithoutIssuance) return reconnect(this.options, profile);
        await writeCredentials(
          this.options.dataDir,
          { ...credentials, refreshOwnerPid: undefined },
          this.options.guard,
        );
        resolved = true;
        throw error;
      }
      let tokens: z.infer<typeof TokenResponseSchema>;
      try {
        tokens = TokenResponseSchema.parse(await readJson(response, 65_536));
      } catch {
        return reconnect(this.options, profile);
      }
      this.current(profile);
      if (tokens.scope !== undefined) {
        const scopes = tokens.scope.split(' ').filter(Boolean);
        if (scopes.some((scope) => !profile.scopes.includes(scope))) return reconnect(this.options, profile);
        this.options.store.setProfile({ ...profile, scopes });
      }
      const replacement = {
        ...credentials,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        refreshPending: false,
        refreshOwnerPid: undefined,
      };
      await writeCredentials(this.options.dataDir, replacement, this.options.guard);
      resolved = true;
      return replacement;
    } catch (error) {
      if (!resolved) {
        // Persistence can fail after rotation, too. Remember unusability when
        // possible; the pending marker plus released lock also blocks readers
        // if the profile database itself cannot be written.
        try {
          reconnect(this.options, profile);
        } catch {
          /* Return a secret-free error below. */
        }
        throw new McpError('reconnect_required', 'Run boardsesh-mcp login to reconnect this profile.');
      }
      throw error;
    }
  }

  async request(
    profile: Profile,
    path: string,
    options: { method?: string; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<unknown> {
    const method = options.method ?? 'GET';
    const url = new URL(path, API_ORIGIN);
    const validRoute =
      method === 'GET'
        ? /^\/v1\/(?:me|logbook\/changes|logbook\/ticks\/[^/]+|workouts(?:\/[^/]+)?)$/.test(url.pathname)
        : method === 'POST'
          ? url.pathname === '/v1/workouts'
          : method === 'DELETE' && /^\/v1\/workouts\/[^/]+$/.test(url.pathname);
    if (
      !path.startsWith('/v1/') ||
      url.origin !== API_ORIGIN ||
      url.hash ||
      url.username ||
      url.password ||
      !validRoute
    ) {
      throw new McpError('invalid_request', 'Only supported Boardsesh partner API routes may be requested.');
    }
    let credentials = await this.credentials(profile);
    for (let attempt = 0; attempt < 2; attempt++) {
      this.current(profile);
      const response = await fetchBounded(this.fetcher, url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      this.current(profile);
      if (response.status === 401) {
        await response.body?.cancel();
        if (attempt === 1) return reconnect(this.options, profile);
        credentials = await this.refresh(profile, credentials);
        continue;
      }
      if (!response.ok) throw await refusal(response);
      if (response.status === 204) return undefined;
      const payload = await readJson(response);
      this.current(profile);
      return payload;
    }
    throw new McpError('reconnect_required', 'Run boardsesh-mcp login again.');
  }
}

export interface LoginOptions extends AuthOptions {
  clientId: string;
  clientIdSource?: 'bundled' | 'override';
  onAuthorizationUrl?: (url: string) => void | Promise<void>;
  timeoutMs?: number;
}

export async function login(options: LoginOptions): Promise<Profile> {
  options.guard.assertHeld();
  if (!options.clientId.trim())
    throw new McpError('client_id_required', 'Configure the registered public app client ID before login.');
  const previousGeneration = options.store.getProfile()?.generation;
  const assertUnchanged = () => {
    options.guard.assertHeld();
    if (options.store.getProfile()?.generation !== previousGeneration) {
      throw new McpError('profile_changed', 'The active account changed during login. Start login again.');
    }
  };
  const fetcher = options.fetch ?? fetch;
  const discovery = await fetchBounded(fetcher, `${API_ORIGIN}/.well-known/oauth-authorization-server/api/auth`);
  if (!discovery.ok) throw await refusal(discovery);
  const metadata = await readJson(discovery, 65_536);
  if (
    !record(metadata) ||
    metadata.issuer !== ISSUER ||
    metadata.authorization_endpoint !== `${ISSUER}/oauth2/authorize` ||
    metadata.token_endpoint !== `${ISSUER}/oauth2/token` ||
    !Array.isArray(metadata.code_challenge_methods_supported) ||
    !metadata.code_challenge_methods_supported.includes('S256')
  ) {
    throw new McpError(
      'invalid_discovery',
      'Boardsesh OAuth discovery did not match the expected issuer and PKCE endpoints.',
    );
  }
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The server can reject while the caller is still opening the browser.
  void codePromise.catch(() => undefined);
  let accepted = false;
  const server = createServer((request, response) => {
    const callback = new URL(request.url ?? '/', 'http://127.0.0.1');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (
      accepted ||
      request.method !== 'GET' ||
      callback.pathname !== '/oauth/boardsesh' ||
      callback.searchParams.getAll('state').length !== 1 ||
      callback.searchParams.get('state') !== state
    ) {
      response.writeHead(400).end('Invalid OAuth callback.');
      return;
    }
    if (callback.searchParams.getAll('iss').length !== 1 || callback.searchParams.get('iss') !== ISSUER) {
      response.writeHead(400).end('Unexpected OAuth issuer.');
      return;
    }
    if (callback.searchParams.has('error')) {
      accepted = true;
      response.writeHead(400).end('Authorization declined. Return to your terminal.');
      rejectCode(new McpError('authorization_declined', 'Boardsesh authorization was declined.'));
      return;
    }
    const code = callback.searchParams.get('code');
    if (!code || callback.searchParams.getAll('code').length !== 1) {
      response.writeHead(400).end('Missing authorization code.');
      return;
    }
    accepted = true;
    response.writeHead(200).end('Return to your terminal to finish connecting Boardsesh.');
    resolveCode(code);
  });
  server.on('error', () =>
    rejectCode(new McpError('callback_unavailable', 'Could not open the local OAuth callback.')),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let code: string;
  let redirectUri: string;
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(new McpError('callback_unavailable', 'Could not open the local OAuth callback.'));
      server.once('error', failed);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', failed);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new McpError('callback_unavailable', 'OAuth callback address is unavailable.');
    redirectUri = `http://127.0.0.1:${address.port}/oauth/boardsesh`;
    const authorization = new URL(`${ISSUER}/oauth2/authorize`);
    authorization.search = new URLSearchParams({
      response_type: 'code',
      client_id: options.clientId,
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      resource: RESOURCE,
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    timer = setTimeout(
      () => rejectCode(new McpError('authorization_timeout', 'Login timed out. Run boardsesh-mcp login again.')),
      options.timeoutMs ?? 300_000,
    );
    await options.onAuthorizationUrl?.(authorization.toString());
    code = await codePromise;
  } finally {
    if (timer) clearTimeout(timer);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assertUnchanged();
  // Authorization codes are single-use. A lost response requires a new login.
  const exchange = await fetchBounded(fetcher, `${ISSUER}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: options.clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  });
  if (!exchange.ok) throw await refusal(exchange);
  const tokens = TokenResponseSchema.safeParse(await readJson(exchange, 65_536));
  if (!tokens.success)
    throw new McpError('invalid_response', 'OAuth did not return usable access and refresh tokens. Restart login.');
  try {
    const identity = await fetchBounded(fetcher, `${API_ORIGIN}/v1/me`, {
      headers: { Authorization: `Bearer ${tokens.data.access_token}` },
    });
    if (!identity.ok) throw await refusal(identity);
    const climber = await readJson(identity, 65_536);
    if (!record(climber) || typeof climber.id !== 'string' || !climber.id) {
      throw new McpError('invalid_response', 'Boardsesh did not return a partner account identity.');
    }
    assertUnchanged();
    const profile: Profile = {
      issuer: ISSUER,
      clientId: options.clientId,
      clientIdSource: options.clientIdSource ?? 'override',
      subject: climber.id,
      accountId: createHash('sha256')
        .update(JSON.stringify([ISSUER, options.clientId, climber.id]))
        .digest('hex'),
      generation: randomUUID(),
      authStatus: 'connected',
      scopes: tokens.data.scope?.split(' ').filter(Boolean) ?? [...SCOPES],
    };
    // A crash between the file and DB writes leaves a generation mismatch; network
    // access then requires reconnect rather than accidentally using another account.
    await writeCredentials(
      options.dataDir,
      {
        version: 1,
        issuer: ISSUER,
        clientId: profile.clientId,
        accountId: profile.accountId,
        generation: profile.generation,
        accessToken: tokens.data.access_token,
        refreshToken: tokens.data.refresh_token,
        refreshPending: false,
      },
      options.guard,
    );
    assertUnchanged();
    options.store.activateProfile(profile);
    return profile;
  } catch (error) {
    await revokeIssuedFamily(fetcher, options.clientId, tokens.data.refresh_token);
    throw error;
  }
}

export async function logout(options: AuthOptions): Promise<{ remoteRevoked: boolean }> {
  options.guard.assertHeld();
  const profile = options.store.getProfile();
  const credentials = await readCredentials(options.dataDir).catch(() => undefined);
  if (profile) options.store.setProfile({ ...profile, authStatus: 'logged_out' });
  let remoteRevoked = false;
  if (credentials && !credentials.refreshPending && credentials.generation === profile?.generation) {
    try {
      const response = await fetchBounded(options.fetch ?? fetch, `${ISSUER}/oauth2/revoke`, {
        method: 'POST',
        body: new URLSearchParams({
          token: credentials.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: credentials.clientId,
        }),
      });
      remoteRevoked = response.ok;
      await response.body?.cancel();
    } catch {
      /* Local logout still succeeds when remote revocation is unavailable. */
    }
  }
  options.guard.assertHeld();
  await removeCredentials(options.dataDir, options.guard);
  return { remoteRevoked };
}
