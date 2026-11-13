import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { WebSocket, type WebSocketServer } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { authEmailProjection, authSession, users } from '@boardsesh/db/schema/auth';
import { createEnvironment } from './environment';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { beginBrowserIntent, commitBrowserLogin, createUnpublishedBrowserBinding } from '../browser-binding';
import { issueBrowserDelegation } from '../browser-delegation';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const stream = vi.hoisted(() => ({ deliver: undefined as ((event: string | null) => void) | undefined }));
vi.mock('graphql', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('graphql') as typeof import('graphql');
});
// Only application payload production is controlled. Actual Yoga/graphql-ws,
// crypto, middleware, admission core and primary SQL remain in the path.
vi.mock('../../../graphql/index', async () => {
  const { GraphQLObjectType, GraphQLSchema, GraphQLString } = await import('graphql');
  return {
    schema: new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          viewer: {
            type: GraphQLString,
            resolve: (_source: unknown, _arguments: unknown, context: ConnectionContext) => context.userId ?? null,
          },
        },
      }),
      subscription: new GraphQLObjectType({
        name: 'Subscription',
        fields: {
          retainedViewer: {
            type: GraphQLString,
            subscribe: async function* () {
              while (true) {
                const event = await new Promise<string | null>((resolve) => {
                  stream.deliver = resolve;
                });
                stream.deliver = undefined;
                if (event === null) return;
                yield { retainedViewer: event };
              }
            },
          },
        },
      }),
    }),
  };
});
vi.mock('../../credential-database', () => ({ getCredentialDatabase: vi.fn() }));
vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_SHARED_DELEGATION_DATABASE');
      },
    },
  ),
  dbRead: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_SHARED_DELEGATION_DATABASE');
      },
    },
  ),
}));
vi.mock('../../../services/room-manager', () => ({
  roomManager: {
    registerClient: vi.fn().mockResolvedValue('owned-participant'),
    clearBoardWriterForConnection: vi.fn().mockResolvedValue(undefined),
    disconnectClient: vi.fn().mockResolvedValue(undefined),
    removeClient: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../../services/user-activity', () => ({
  recordUserActivity: vi.fn().mockResolvedValue(undefined),
  resolveActivityPlatform: () => undefined,
}));
import { getCredentialDatabase } from '../../credential-database';
import { setupWebSocketServer } from '../../../websocket/setup';
import { createYogaInstance } from '../../../graphql/yoga';
import { AuthAdmissionUnavailableError } from '../../human-admission';

const qualification = {
  expectedProjectionId: randomUUID(),
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
};
const backendKey = 'owned-transport-backend-only-delegation-secret-6975';
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let userId: string;
let otherUserId: string;
let server: Server;
let websocketServer: WebSocketServer;
let pingInterval: NodeJS.Timeout;
let origin: string;
const sockets = new Set<WebSocket>();
async function candidate(owner: string) {
  const credential = { kind: 'canonical-token' as const, token: randomUUID() };
  await environment.database.insert(authSession).values({
    id: randomUUID(),
    token: credential.token,
    userId: owner,
    expiresAt: new Date(Date.now() + 3_600_000),
    updatedAt: new Date(),
    revocationGeneration: 0,
  });
  return credential;
}
async function selected() {
  const created = await createUnpublishedBrowserBinding(environment.database, qualification);
  if (created.status !== 'created') throw new Error('Owned binding unavailable');
  const intent = await beginBrowserIntent(environment.database, qualification, created.token, {
    operation: 'login',
    expectedVersion: 0,
  });
  if (intent.status !== 'prepared') throw new Error('Owned intent unavailable');
  const credential = await candidate(userId);
  const committed = await commitBrowserLogin(
    environment.database,
    qualification,
    created.token,
    intent.intentToken,
    credential,
  );
  if (committed.status !== 'committed') throw new Error('Owned login unavailable');
  const actor = { version: committed.cursor.version, credential };
  const lease = await issueBrowserDelegation(environment.database, qualification, {
    bindingToken: created.token,
    actor,
  });
  if (lease.status !== 'admitted') throw new Error('Owned lease unavailable');
  return { bindingToken: created.token, actor, token: lease.token };
}
async function switchAccount(selection: Awaited<ReturnType<typeof selected>>) {
  const intent = await beginBrowserIntent(environment.database, qualification, selection.bindingToken, {
    operation: 'login',
    expectedVersion: selection.actor.version,
    presented: selection.actor,
  });
  if (intent.status !== 'prepared') throw new Error('Owned switch unavailable');
  expect(
    (
      await commitBrowserLogin(
        environment.database,
        qualification,
        selection.bindingToken,
        intent.intentToken,
        await candidate(otherUserId),
        selection.actor,
      )
    ).status,
  ).toBe('committed');
}
type Frame = { type: string; id?: string; payload?: unknown };
async function connect(token: string) {
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/graphql', 'graphql-transport-ws');
  sockets.add(socket);
  const frames: Frame[] = [];
  socket.on('message', (message) => {
    const bytes = Array.isArray(message)
      ? Buffer.concat(message)
      : message instanceof ArrayBuffer
        ? Buffer.from(message)
        : message;
    frames.push(JSON.parse(bytes.toString('utf8')) as Frame);
  });
  const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'connection_init', payload: { authToken: token } }));
  return { socket, frames, closed };
}

async function waitFor(assertion: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!assertion()) {
    if (performance.now() >= deadline) throw new Error('Owned transport observation deadline');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
describe('selected browser leases through actual HTTP and WebSocket transports', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    for (const tag of ['0311_browser_binding_selection', '0312_browser_selection_possession'])
      await environment.client.unsafe(
        readFileSync(new URL(`../../../../../db/drizzle/${tag}.sql`, import.meta.url), 'utf8'),
      );
  });
  beforeEach(async () => {
    await environment.client.unsafe(
      'TRUNCATE auth_browser_bindings, auth_email_projection, auth_migration_epochs, auth_subject_cutoffs, auth_session_denials, auth_security_mutation_events, auth_credential_lineage, users CASCADE',
    );
    userId = randomUUID();
    otherUserId = randomUUID();
    await environment.database.insert(users).values([
      { id: userId, email: `${userId}@example.test` },
      { id: otherUserId, email: `${otherUserId}@example.test` },
    ]);
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId: qualification.expectedProjectionId });
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
    for (const [name, setting] of Object.entries({
      BROWSER_DELEGATION_SECRET: backendKey,
      CURRENT_STORE_AUTH_PROJECTION_ID: qualification.expectedProjectionId,
      CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
      CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-transport-deleted-email-digest-key-6975',
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      DEBUG_SQL: 'false',
    }))
      vi.stubEnv(name, setting);
    vi.mocked(getCredentialDatabase).mockImplementation(async (contract) => {
      if (contract !== 'private-browser-v1') throw new Error('UNEXPECTED_CREDENTIAL_PROFILE');
      return environment.database;
    });
    // Keep wall/DB clocks, socket I/O and admission deadlines real. Controlling
    // only intervals lets delivery be tested independently of the idle sweep.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    server = createServer();
    const setup = setupWebSocketServer(server);
    websocketServer = setup.wss;
    pingInterval = setup.pingInterval;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned transport server unavailable');
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    stream.deliver?.(null);
    stream.deliver = undefined;
    clearInterval(pingInterval);
    for (const socket of sockets) socket.terminate();
    sockets.clear();
    await new Promise<void>((resolve) => websocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.mocked(getCredentialDatabase).mockReset();
  });
  afterAll(async () => environment?.close());

  it('serves only the selected identity over HTTP and returns401 after a switch', async () => {
    const selection = await selected();
    const yoga = createYogaInstance();
    const request = () =>
      yoga.fetch('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${selection.token}` },
        body: JSON.stringify({ query: '{ viewer }' }),
      });
    const admitted = await request();
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toEqual({ data: { viewer: userId } });
    await switchAccount(selection);
    const refused = await request();
    expect(refused.status).toBe(401);
    expect(JSON.stringify(await refused.json())).not.toContain(userId);
  });
  it('admits a live WebSocket and refuses a new operation after an account switch', async () => {
    const selection = await selected();
    const connection = await connect(selection.token);
    await waitFor(() => connection.frames.some((frame) => frame.type === 'connection_ack'));
    connection.socket.send(JSON.stringify({ id: 'before', type: 'subscribe', payload: { query: '{ viewer }' } }));
    await waitFor(() => connection.frames.some((frame) => frame.type === 'next'));
    expect(connection.frames.find((frame) => frame.type === 'next')?.payload).toEqual({ data: { viewer: userId } });
    await switchAccount(selection);
    connection.socket.send(JSON.stringify({ id: 'after', type: 'subscribe', payload: { query: '{ viewer }' } }));
    expect(await connection.closed).toBe(4401);
    expect(connection.frames.filter((frame) => frame.id === 'after' && frame.type === 'next')).toEqual([]);
  });
  it('withholds an already subscribed private event after an account switch', async () => {
    const selection = await selected();
    const connection = await connect(selection.token);
    await waitFor(() => connection.frames.some((frame) => frame.type === 'connection_ack'));
    connection.socket.send(
      JSON.stringify({ id: 'events', type: 'subscribe', payload: { query: 'subscription { retainedViewer }' } }),
    );
    await waitFor(() => stream.deliver !== undefined);
    stream.deliver?.('owned-before-switch');
    await waitFor(() => connection.frames.some((frame) => frame.type === 'next'));
    expect(connection.frames.find((frame) => frame.type === 'next')?.payload).toEqual({
      data: { retainedViewer: 'owned-before-switch' },
    });
    await waitFor(() => stream.deliver !== undefined);
    await switchAccount(selection);
    stream.deliver?.('owned-after-switch-must-stay-private');
    expect(await connection.closed).toBe(4401);
    expect(JSON.stringify(connection.frames)).not.toContain('owned-after-switch-must-stay-private');
  });
  it('closes idle old selections through the actual interval sweep', async () => {
    const selection = await selected();
    const connection = await connect(selection.token);
    await waitFor(() => connection.frames.some((frame) => frame.type === 'connection_ack'));
    await switchAccount(selection);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await connection.closed).toBe(4401);
  });
  it('returns503 and closes1013 on primary uncertainty without anonymous fallback', async () => {
    const selection = await selected();
    const connection = await connect(selection.token);
    await waitFor(() => connection.frames.some((frame) => frame.type === 'connection_ack'));
    vi.mocked(getCredentialDatabase).mockRejectedValue(new AuthAdmissionUnavailableError());
    const response = await createYogaInstance().fetch('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${selection.token}` },
      body: JSON.stringify({ query: '{ viewer }' }),
    });
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(userId);
    connection.socket.send(JSON.stringify({ id: 'outage', type: 'subscribe', payload: { query: '{ viewer }' } }));
    expect(await connection.closed).toBe(1013);
  });
});
