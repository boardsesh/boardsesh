/**
 * A public/native OAuth CLI; no dependencies. Node 22.18+ runs TypeScript directly.
 * Register http://127.0.0.1:8765/oauth/boardsesh as a native redirect (port ignored).
 * node examples/logbook-sync.ts connect --client-id YOUR_ID --file /private/logbook.json
 * node examples/logbook-sync.ts sync --file /private/logbook.json
 * node examples/logbook-sync.ts disconnect --file /private/logbook.json
 * The JSON contains credentials. Keep it outside your repository; never publish it.
 */
/// <reference types="node" />
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const API = 'https://api.boardsesh.com';
const ISSUER = `${API}/api/auth`;
const RESOURCE = `${API}/v1`;
type Tick = { id: string; [field: string]: unknown };
type Session = { id: string; [field: string]: unknown };
type Tokens = { accessToken: string; refreshToken: string };
export type SyncState = {
  version: 1;
  clientId: string;
  subject: string;
  tokens: Tokens;
  ticks: Record<string, Tick>;
  sessions: Record<string, Session>;
  cursor?: string;
  fullSyncRequired: boolean;
};
export class ReconnectNeeded extends Error {}
export class CursorExpired extends Error {}

function record(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}
function tokenPair(payload: unknown): Tokens {
  if (!record(payload) || typeof payload.access_token !== 'string' || typeof payload.refresh_token !== 'string') {
    throw new Error('Token response did not contain an access and refresh token.');
  }
  return { accessToken: payload.access_token, refreshToken: payload.refresh_token };
}

/** One atomic file contains both the ticks and the cursor that describes them. */
export async function writeState(file: string, state: SyncState): Promise<void> {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
    // Persist the rename as well as its contents on POSIX filesystems.
    if (process.platform !== 'win32') {
      const directory = await open(dirname(file), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readState(file: string): Promise<SyncState> {
  const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (
    !record(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.clientId !== 'string' ||
    typeof parsed.subject !== 'string' ||
    !record(parsed.tokens) ||
    typeof parsed.tokens.accessToken !== 'string' ||
    typeof parsed.tokens.refreshToken !== 'string' ||
    !record(parsed.ticks) ||
    (parsed.sessions !== undefined && !record(parsed.sessions)) ||
    typeof parsed.fullSyncRequired !== 'boolean' ||
    (parsed.cursor !== undefined && typeof parsed.cursor !== 'string')
  ) {
    throw new Error('Unrecognized state file; keep the original and connect using a new file.');
  }
  // Older tick-only state files keep their published copy until a full import.
  return { ...parsed, sessions: parsed.sessions ?? {} } as SyncState;
}

/** The whole command owns this lock, including refreshes, reconnects and file replacement. */
export async function withStateLock<Result>(file: string, work: () => Promise<Result>): Promise<Result> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(`${file}.lock`, 'wx', 0o600);
  } catch (error) {
    if (record(error) && error.code === 'EEXIST') {
      throw new Error(
        `Another command owns ${file}.lock. After a crash, confirm no command is running before removing it.`,
      );
    }
    throw error;
  }
  try {
    return await work();
  } finally {
    await handle.close();
    await rm(`${file}.lock`, { force: true });
  }
}

const MAX_INLINE_RETRY_WAIT_MS = 60_000;

function boundedRetryWait(milliseconds: number): number {
  if (milliseconds > MAX_INLINE_RETRY_WAIT_MS)
    throw new Error('Boardsesh asked for a retry later than 60 seconds. Keep the file and retry later.');
  return milliseconds;
}

function waitMilliseconds(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return boundedRetryWait(seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return boundedRetryWait(Math.max(0, date - Date.now()));
  }
  return 1000 * 2 ** attempt;
}

async function refresh(file: string, state: SyncState): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${ISSUER}/oauth2/token`, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: state.tokens.refreshToken,
          client_id: state.clientId,
          resource: RESOURCE,
        }),
      });
    } catch {
      // A timeout may mean the rotating token was already consumed. Do not replay it.
      throw new Error('Refresh outcome is unknown. Reconnect; do not retry the saved refresh token.');
    }
    if (response.ok) {
      const newest = tokenPair(await response.json());
      state.tokens = newest;
      await writeState(file, state); // Durable before any request uses the replacement.
      return;
    }
    const payload: unknown = await response.json().catch(() => null);
    if (record(payload) && payload.error === 'invalid_grant') throw new ReconnectNeeded('Reconnect Boardsesh.');
    if (response.status === 429 || response.status >= 500) {
      // Explicit server refusals are retryable; a transport error above is ambiguous.
      if (attempt < 4) {
        await delay(waitMilliseconds(response, attempt));
        continue;
      }
    }
    throw new Error(`Token refresh failed (${response.status}); keep the file and retry later.`);
  }
}

/** Refresh once per request, with bounded retry on transport failures, 429 and 5xx. */
export async function apiRequest(file: string, state: SyncState, path: string, method = 'GET'): Promise<Response> {
  let refreshed = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${state.tokens.accessToken}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (method === 'DELETE')
        throw new Error('Disconnect outcome is unknown; check Connected apps before deleting your file.');
      if (attempt === 5) throw new Error('Network unavailable; keep the file and retry later.');
      await delay(1000 * 2 ** attempt);
      continue;
    }
    if (response.ok) return response;
    if (response.status === 401 && !refreshed) {
      await refresh(file, state);
      refreshed = true;
      continue;
    }
    if (response.status === 401) throw new ReconnectNeeded('Reconnect Boardsesh.');
    if (response.status === 410) throw new CursorExpired('Start a new full download.');
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      await delay(waitMilliseconds(response, attempt));
      continue;
    }
    throw new Error(
      `API request failed (${response.status}); request ID ${response.headers.get('Boardsesh-Request-Id') ?? 'unknown'}.`,
    );
  }
  throw new Error('Retry limit reached; keep the file and retry later.');
}

function applyChanges(ticks: Record<string, Tick>, sessions: Record<string, Session>, changes: unknown[]): void {
  for (const change of changes) {
    if (!record(change)) throw new Error('Invalid change entry.');
    if (change.type === 'tick') {
      if (!record(change.tick) || typeof change.tick.id !== 'string') throw new Error('Invalid tick entry.');
      // Define an own property even for a future id such as "__proto__".
      Object.defineProperty(ticks, change.tick.id, {
        value: change.tick,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else if (change.type === 'tick.deleted') {
      if (typeof change.id !== 'string') throw new Error('Invalid deletion entry.');
      delete ticks[change.id];
    } else if (change.type === 'session') {
      if (!record(change.session) || typeof change.session.id !== 'string') throw new Error('Invalid session entry.');
      Object.defineProperty(sessions, change.session.id, {
        value: change.session,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else if (change.type === 'session.deleted') {
      if (typeof change.id !== 'string') throw new Error('Invalid session deletion entry.');
      delete sessions[change.id];
    }
    // Unknown change types are additive; ignore them and advance the cursor.
  }
}

export async function syncLogbook(file: string, state: SyncState): Promise<void> {
  for (let restart = 0; restart < 2; restart++) {
    const fullSync = state.fullSyncRequired || !state.cursor;
    if (fullSync) {
      state.fullSyncRequired = true;
      await writeState(file, state);
    }
    const replacement: Record<string, Tick> = {};
    const replacementSessions: Record<string, Session> = {};
    let cursor = fullSync ? undefined : state.cursor;
    try {
      for (;;) {
        const query = new URLSearchParams({ limit: '200' });
        if (cursor) query.set('cursor', cursor);
        const response = await apiRequest(file, state, `/v1/logbook/changes?${query}`);
        const page: unknown = await response.json();
        if (
          !record(page) ||
          !Array.isArray(page.changes) ||
          typeof page.cursor !== 'string' ||
          typeof page.hasMore !== 'boolean'
        ) {
          throw new Error('Invalid changes response.');
        }
        applyChanges(
          fullSync ? replacement : state.ticks,
          fullSync ? replacementSessions : state.sessions,
          page.changes,
        );
        cursor = page.cursor;
        if (!fullSync) {
          state.cursor = cursor;
          await writeState(file, state);
        }
        if (!page.hasMore) break; // Empty pages with hasMore=true still continue.
      }
      if (fullSync) {
        state.ticks = replacement;
        state.sessions = replacementSessions;
        state.cursor = cursor;
        state.fullSyncRequired = false;
        await writeState(file, state); // Publish the replacement and final cursor together.
      }
      return;
    } catch (error) {
      if (!(error instanceof CursorExpired)) throw error;
      state.fullSyncRequired = true;
      await writeState(file, state); // Durable even while the previous copy has its old cursor.
    }
  }
  throw new CursorExpired('Repeated cursor expiry; keep the file and retry later.');
}

async function connect(clientId: string): Promise<SyncState> {
  const discovery = await fetch(`${API}/.well-known/oauth-authorization-server/api/auth`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!discovery.ok) throw new Error(`Discovery failed (${discovery.status}).`);
  const metadata: unknown = await discovery.json();
  if (
    !record(metadata) ||
    metadata.issuer !== ISSUER ||
    metadata.authorization_endpoint !== `${ISSUER}/oauth2/authorize` ||
    metadata.token_endpoint !== `${ISSUER}/oauth2/token`
  ) {
    throw new Error('Unexpected authorization-server metadata.');
  }
  const verifier = randomBytes(32).toString('base64url');
  const expectedState = randomBytes(32).toString('base64url');
  let receiveCode: (code: string) => void = () => {};
  let rejectCode: (error: Error) => void = () => {};
  const codePromise = new Promise<string>((resolveCode, reject) => {
    receiveCode = resolveCode;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    const callback = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (
      request.method !== 'GET' ||
      callback.pathname !== '/oauth/boardsesh' ||
      callback.searchParams.get('state') !== expectedState
    ) {
      response.writeHead(400).end('Invalid callback.');
      return;
    }
    if (callback.searchParams.get('iss') !== ISSUER) {
      response.writeHead(400).end('Unexpected issuer.');
      rejectCode(new Error('Authorization issuer did not match.'));
      return;
    }
    const code = callback.searchParams.get('code');
    if (!code) {
      response.writeHead(400).end('Authorization declined.');
      rejectCode(new Error('Authorization declined.'));
      return;
    }
    response
      .writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
      .end('Return to your terminal.');
    receiveCode(code);
  });
  server.on('error', rejectCode);
  await new Promise<void>((listening, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', listening);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback listener unavailable.');
  const redirectUri = `http://127.0.0.1:${address.port}/oauth/boardsesh`;
  const authorization = new URL(metadata.authorization_endpoint);
  authorization.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'logbook:read sessions:read profile:read offline_access',
    resource: RESOURCE,
    state: expectedState,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  process.stdout.write(`Open this URL in your system browser:\n${authorization}\n`);
  const timeout = setTimeout(() => rejectCode(new Error('Authorization timed out after 5 minutes.')), 300_000);
  let code: string;
  try {
    code = await codePromise;
  } finally {
    clearTimeout(timeout);
    server.closeAllConnections();
    await new Promise<void>((closed) => server.close(() => closed()));
  }
  // Codes work once: never retry this exchange after a transport failure.
  const exchanged = await fetch(metadata.token_endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: RESOURCE,
    }),
  });
  if (!exchanged.ok) throw new Error(`Code exchange failed (${exchanged.status}); restart connect.`);
  return {
    version: 1,
    clientId,
    subject: '',
    tokens: tokenPair(await exchanged.json()),
    ticks: {},
    sessions: {},
    fullSyncRequired: true,
  };
}

async function main(): Promise<void> {
  const [command, ...argumentsList] = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const argument = argumentsList[index + 1];
    if (!['--file', '--client-id'].includes(flag) || !argument || options.has(flag))
      throw new Error('Use --file PATH and, for connect, --client-id ID.');
    options.set(flag, argument);
  }
  const fileArgument = options.get('--file');
  if (!fileArgument || !['connect', 'sync', 'disconnect'].includes(command)) {
    throw new Error('Usage: node examples/logbook-sync.ts connect|sync|disconnect --file PATH [--client-id ID]');
  }
  const file = resolve(fileArgument);
  await withStateLock(file, async () => {
    if (command === 'connect') {
      const clientId = options.get('--client-id');
      if (!clientId) throw new Error('connect needs --client-id from the developer console.');
      let previous: SyncState | undefined;
      try {
        previous = await readState(file);
      } catch (error) {
        if (!record(error) || error.code !== 'ENOENT') throw error;
      }
      const state = await connect(clientId);
      const meResponse = await fetch(`${API}/v1/me`, {
        headers: { Authorization: `Bearer ${state.tokens.accessToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!meResponse.ok) throw new Error(`Account lookup failed (${meResponse.status}); restart connect.`);
      const me: unknown = await meResponse.json();
      if (!record(me) || typeof me.id !== 'string') throw new Error('Invalid account response.');
      state.subject = me.id;
      if (previous) {
        if (previous.subject !== state.subject || previous.clientId !== clientId) {
          throw new Error('This file belongs to another app or climber. Connect with a different --file.');
        }
        state.ticks = previous.ticks; // Keep the last published copy until a full replacement finishes.
        state.sessions = previous.sessions;
      }
      await writeState(file, state);
      await syncLogbook(file, state);
      process.stdout.write(
        `Connected; ${Object.keys(state.ticks).length} ticks and ${Object.keys(state.sessions).length} sessions saved.\n`,
      );
      return;
    }
    const state = await readState(file);
    if (command === 'disconnect') {
      try {
        const disconnected = await apiRequest(file, state, '/v1/connection', 'DELETE');
        if (disconnected.status !== 204)
          throw new Error('Unexpected disconnect response; check Connected apps before removing your file.');
      } catch (error) {
        if (error instanceof ReconnectNeeded)
          throw new Error(
            'Credentials are unusable. Confirm Disconnect in Boardsesh Connected apps before removing your file.',
          );
        throw error;
      }
      await rm(file); // Only a confirmed 204 permits cleanup, while still holding the same lock.
      process.stdout.write('Disconnected; credentials and the local logbook were removed.\n');
    } else {
      await syncLogbook(file, state);
      process.stdout.write(`${Object.keys(state.ticks).length} ticks saved.\n`);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unexpected failure.'}\n`);
    process.exitCode = 1;
  });
}
