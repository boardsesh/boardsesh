import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request, type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { and, eq, lte, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  ApiErrorResponseSchema,
  LogbookChangesResponseSchema,
  TickSchema,
  renderPublicApiDocument,
  type LogbookChangesResponse,
  type Tick,
} from '@boardsesh/public-api';
import {
  boardseshTicks,
  contentPrivacy,
  userProfiles,
  logbookChangeWatermark,
  logbookChanges,
  logbookSnapshots,
  oauthConnections,
} from '@boardsesh/db/schema';
import { createPartnerAuthorityRuntime, type PartnerAuthorityRuntime } from '../auth/partner/authority';
import { createPartnerLogbookAccess } from '../auth/partner/logbook-access';
import { createPartnerDatabaseHandle } from '../auth/partner/transaction';
import { db, type Database } from '../db/client';
import { API_HOSTNAME, rejectApiHostRequest } from '../handlers/api-host';
import { decodeLogbookCursor, encodeLogbookCursor } from '../handlers/public-api/logbook-cursor';
import { createPublicApiHandler, type PublicApiHandlerOptions } from '../handlers/public-api/router';
import { redisClientManager } from '../redis/client';
import { readLogbookFeedPage, readLogbookTick, type LogbookPageReader } from '../services/logbook-feed';
import { pruneLogbookChanges } from '../services/logbook-prune';
import {
  LOGBOOK_SNAPSHOT_BUILD_SLOT_LOCK_CLASS,
  LOGBOOK_SNAPSHOT_BUILD_SLOTS,
  readLogbookSnapshotPage,
} from '../services/logbook-snapshot';
import {
  createPartnerTestEnvironment,
  TEST_CONFIGURATION,
  testSessionBridge,
  type PartnerTestEnvironment,
  type TestClient,
  type TestClimber,
} from '../auth/partner/__tests__/partner-fixture';
import { getWorkerDatabaseUrl } from './worker-db';

/**
 * `GET /v1/logbook/changes`, `GET /v1/logbook/ticks/{id}` and
 * `GET /v1/openapi.json` through the real handler, real Postgres and real Redis,
 * against docs/partner-api.md section 3 and the `@boardsesh/public-api` schemas.
 *
 * Remove these protections to prove the tests fail:
 * - the scope check: the insufficient-scope tests fail.
 * - the cursor's connection binding: the other-app and reconnect tests fail.
 * - the connection re-check in the page's read transaction: the
 *   ended-during-the-request test fails.
 * - `advance` on a building page: the building test never sees ticks.
 * - the empty page on 57014/55P03: the timeout tests get 500.
 * - releasing the `/v1` permit before snapshot work: the permit test gets 503s.
 * - `createAllowed` or charging only real creations: the creation-limit tests fail.
 * - the spray rule at delivery: the wall-made-private test leaks the name.
 */

const MINUTE_MS = 60_000;
const CHANGES_PATH = '/v1/logbook/changes';
const LOGBOOK_SCOPES = ['logbook:read', 'offline_access'];

beforeAll(async () => {
  await redisClientManager.connect();
});

afterAll(async () => {
  await redisClientManager.disconnect();
});

function limiterKey(identity: string, operation: string): string {
  return `ratelimit:${identity}:${operation}:${Math.floor(Date.now() / MINUTE_MS)}`;
}

async function seedLimiter(identity: string, operation: string, count: number): Promise<void> {
  await redisClientManager.getClients().publisher.set(limiterKey(identity, operation), String(count), 'EX', 120);
}

async function limiterCount(identity: string, operation: string): Promise<number> {
  return Number(await redisClientManager.getClients().publisher.get(limiterKey(identity, operation)));
}

/** Limits use fixed one-minute windows, so a counting test must not straddle a rollover. */
async function enoughWindowLeft(minimumMs = 20_000): Promise<void> {
  const remainingMs = MINUTE_MS - (Date.now() % MINUTE_MS);
  if (remainingMs < minimumMs) await new Promise((resolve) => setTimeout(resolve, remainingMs + 50));
}

function randomClientIp(): string {
  return `198.51.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 254) + 1}`;
}

interface SentResponse {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
}

interface SendOptions {
  token?: string;
  headers?: Record<string, string>;
  clientIp?: string;
}

/** A server wired the way `startServer` wires it: the public API, then the API host filter. */
async function startApiHost(options: PublicApiHandlerOptions) {
  const handler = createPublicApiHandler(options);
  const server = createServer((req, res) => {
    void (async () => {
      if (await handler(req, res)) return;
      const pathname = new URL(req.url ?? '/', 'http://backend.internal').pathname;
      if (rejectApiHostRequest(req, res, pathname)) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reachedDispatcher: true }));
    })();
  });
  const openSockets = new Set<Socket>();
  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  function send(method: string, path: string, options: SendOptions = {}): Promise<SentResponse> {
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          agent: false,
          headers: {
            Host: API_HOSTNAME,
            'X-Forwarded-For': options.clientIp ?? randomClientIp(),
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
            ...options.headers,
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () =>
            resolve({
              status: incoming.statusCode ?? 0,
              headers: incoming.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
  }

  return {
    send,
    async close() {
      for (const socket of openSockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type ApiHost = Awaited<ReturnType<typeof startApiHost>>;

function changesPath(query: { cursor?: string; limit?: number } = {}): string {
  const search = new URLSearchParams();
  if (query.cursor !== undefined) search.set('cursor', query.cursor);
  if (query.limit !== undefined) search.set('limit', String(query.limit));
  const encoded = search.toString();
  return encoded ? `${CHANGES_PATH}?${encoded}` : CHANGES_PATH;
}

/** A 200 page, checked against the strict contract. */
function pageOf(response: SentResponse): LogbookChangesResponse {
  expect(response.status, response.body).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['boardsesh-request-id']).toMatch(/^req_/);
  const body = JSON.parse(response.body) as LogbookChangesResponse;
  expect(LogbookChangesResponseSchema.parse(body)).toEqual(body);
  for (const change of body.changes) {
    if (change.type === 'tick') expect(TickSchema.parse(change.tick)).toEqual(change.tick);
  }
  expect(body.cursor).toMatch(/^c3\./);
  return body;
}

/** A documented error, checked against the strict contract. */
function errorOf(response: SentResponse, status: number, error: string) {
  expect(response.status, response.body).toBe(status);
  expect(response.headers['cache-control']).toBe('no-store');
  const body = ApiErrorResponseSchema.parse(JSON.parse(response.body));
  expect(body.error).toBe(error);
  expect(body.requestId).toBe(response.headers['boardsesh-request-id']);
  return body;
}

let nextTick = 0;
function tickUuid(): string {
  nextTick += 1;
  return `lb-api-tick-${process.pid}-${nextTick}-${randomUUID()}`;
}

type TickOverrides = Partial<typeof boardseshTicks.$inferInsert>;

async function insertTicks(userId: string, count: number, overrides: TickOverrides = {}): Promise<string[]> {
  const rows = Array.from({ length: count }, (_unused, index) => ({
    uuid: tickUuid(),
    userId,
    boardType: 'kilter',
    climbUuid: `lb-api-climb-${index}`,
    angle: 40,
    status: 'send' as const,
    attemptCount: 2,
    quality: 3,
    difficulty: 21,
    comment: 'crimpy',
    climbedAt: `2026-05-01 10:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`,
    ...overrides,
  }));
  await db.insert(boardseshTicks).values(rows);
  return rows.map((row) => row.uuid);
}

/** Waits until every write committed so far is below the feed horizon. */
async function waitForWritesToSettle(): Promise<void> {
  const [fence] = (await db.execute(sql`SELECT pg_current_xact_id()::text AS txid`)) as unknown as Array<{
    txid: string;
  }>;
  const deadline = Date.now() + 30_000;
  for (;;) {
    const [snapshot] = (await db.execute(
      sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS horizon`,
    )) as unknown as Array<{ horizon: string }>;
    if (BigInt(snapshot.horizon) > BigInt(fence.txid)) return;
    if (Date.now() > deadline) throw new Error(`Horizon stuck at ${snapshot.horizon}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Holds every cluster-wide build slot from a session of its own, so builds cannot run. */
async function holdBuildSlots(): Promise<{ release(): Promise<void> }> {
  const holder = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
  const reserved = await holder.reserve();
  for (let slot = 0; slot < LOGBOOK_SNAPSHOT_BUILD_SLOTS; slot += 1) {
    await reserved`SELECT pg_advisory_lock(${LOGBOOK_SNAPSHOT_BUILD_SLOT_LOCK_CLASS}::int, ${slot}::int)`;
  }
  return {
    async release() {
      await reserved`SELECT pg_advisory_unlock_all()`;
      reserved.release();
      await holder.end({ timeout: 2 });
    },
  };
}

/** A database whose transactions fail with this Postgres code before running anything. */
function failingDatabase(code: string): Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return async () => {
          throw Object.assign(new Error('canceling statement'), { code });
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

/** A database that runs `before` ahead of every transaction. */
function databaseRunningFirst(before: () => Promise<void>): Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return async (...args: Parameters<Database['transaction']>) => {
          await before();
          return db.transaction(...args);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

describe('the logbook routes', () => {
  let environment: PartnerTestEnvironment;
  let runtime: PartnerAuthorityRuntime;
  let apiHost: ApiHost;
  const extraHosts: ApiHost[] = [];

  beforeAll(async () => {
    environment = await createPartnerTestEnvironment();
    runtime = await createPartnerAuthorityRuntime(environment.database, TEST_CONFIGURATION, {
      plugins: [testSessionBridge(createPartnerDatabaseHandle(environment.database))],
      logbook: { feed: db, snapshots: db },
      close: async () => {},
    });
    apiHost = await startApiHost({ mode: 'allowlist', loadRuntime: async () => runtime });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const host of extraHosts) await host.close();
    await apiHost?.close();
    await environment?.close();
  });

  /** A host whose logbook routes read through other databases. */
  async function hostWithLogbookDatabases(feed: Database, snapshots: Database): Promise<ApiHost> {
    const swapped: PartnerAuthorityRuntime = {
      ...runtime,
      logbook: createPartnerLogbookAccess({ feed, snapshots }, TEST_CONFIGURATION.secrets),
    };
    const host = await startApiHost({ mode: 'allowlist', loadRuntime: async () => swapped });
    extraHosts.push(host);
    return host;
  }

  async function connectionOf(client: TestClient, climber: TestClimber = client.owner) {
    const [connection] = await db
      .select()
      .from(oauthConnections)
      .where(and(eq(oauthConnections.clientId, client.clientId), eq(oauthConnections.userId, climber.userId)));
    return connection;
  }

  /** A connected app holding a logbook token for a climber of its own. */
  async function connectedApp(scopes: string[] = LOGBOOK_SCOPES, owner?: TestClimber) {
    const client = await environment.createClient(owner ? { owner } : {});
    const issued = await environment.issueTokens(client, scopes);
    return { client, climber: client.owner, token: issued.access_token };
  }

  /** A reconnect after Disconnect always passes through the consent screen again. */
  async function reconnect(client: TestClient): Promise<string> {
    const atConsent = await environment.authorize(client, { scopes: LOGBOOK_SCOPES });
    expect(atConsent.location).toContain('/oauth/consent');
    const accepted = await environment.consent(client.owner, {
      accept: true,
      oauth_query: new URL(atConsent.location!).searchParams.toString(),
    });
    const exchanged = await environment.exchange(client, {
      location: accepted.body.url!,
      verifier: atConsent.verifier,
    });
    expect(exchanged.response.status).toBe(200);
    return exchanged.body.access_token!;
  }

  const getChanges = (
    host: ApiHost,
    token: string,
    query: { cursor?: string; limit?: number } = {},
    options: SendOptions = {},
  ) => host.send('GET', changesPath(query), { ...options, token });

  /**
   * Follows the feed the way the documented client does, applying every page,
   * until `hasMore: false`. Returns the copy and the cursor to resume from.
   */
  async function sync(token: string, cursor?: string, limit?: number, host: ApiHost = apiHost) {
    const copy = new Map<string, Tick>();
    const pages: LogbookChangesResponse[] = [];
    let current = cursor;
    for (let request = 0; request < 200; request += 1) {
      const body = pageOf(await getChanges(host, token, { cursor: current, limit }));
      pages.push(body);
      for (const change of body.changes) {
        if (change.type === 'tick') copy.set(change.tick.id, change.tick);
        else if (change.type === 'tick.deleted') copy.delete(change.id);
      }
      current = body.cursor;
      if (!body.hasMore) return { copy, cursor: current, pages };
    }
    throw new Error('The feed never finished');
  }

  describe('a full sync and its catch-up', () => {
    it('downloads every visible tick through the snapshot, then ends on the feed with hasMore false', async () => {
      const { climber, token } = await connectedApp();
      const tickIds = await insertTicks(climber.userId, 7);

      const { copy, pages } = await sync(token, undefined, 3);
      expect([...copy.keys()].sort()).toEqual([...tickIds].sort());
      // Every snapshot page says hasMore, including the last one, which leads into catch-up.
      expect(pages.slice(0, -1).every((body) => body.hasMore)).toBe(true);
      expect(pages.at(-1)?.hasMore).toBe(false);
      expect(pages.length).toBeGreaterThanOrEqual(4);
      for (const body of pages) expect(body.changes.length).toBeLessThanOrEqual(3);
    });

    it('serves edits, deletions and new ticks after the snapshot, at least once, and never another climber', async () => {
      const { climber, token } = await connectedApp();
      const [edited, removed, kept] = await insertTicks(climber.userId, 3);
      await waitForWritesToSettle();
      const first = await sync(token);
      expect(first.copy.size).toBe(3);

      await db.update(boardseshTicks).set({ comment: 'sent it' }).where(eq(boardseshTicks.uuid, edited));
      await db.delete(boardseshTicks).where(eq(boardseshTicks.uuid, removed));
      const [added] = await insertTicks(climber.userId, 1, { climbUuid: 'lb-api-new' });
      const stranger = await environment.createClimber();
      await insertTicks(stranger.userId, 2);
      await waitForWritesToSettle();

      const caughtUp = await sync(token, first.cursor);
      const changes = caughtUp.pages.flatMap((body) => body.changes);
      expect(changes).toContainEqual({ type: 'tick.deleted', id: removed });
      const ids = changes.flatMap((change) => (change.type === 'tick' ? [change.tick.id] : []));
      expect(ids).toEqual(expect.arrayContaining([edited, added]));
      expect(ids).not.toContain(kept);
      const editedTick = changes.find((change) => change.type === 'tick' && change.tick.id === edited);
      expect(editedTick).toMatchObject({ tick: { comment: 'sent it' } });

      const applied = new Map(first.copy);
      for (const change of changes) {
        if (change.type === 'tick') applied.set(change.tick.id, change.tick);
        else if (change.type === 'tick.deleted') applied.delete(change.id);
      }
      expect([...applied.keys()].sort()).toEqual([edited, kept, added].sort());
    });

    it("answers an empty page and the same position when nothing changed, and never shows the climber's id", async () => {
      const { climber, token } = await connectedApp();
      await insertTicks(climber.userId, 1);
      // The horizon is cluster-wide, so another worker's open transaction could
      // otherwise leave the tick for a later page.
      await waitForWritesToSettle();
      const first = await sync(token);
      await waitForWritesToSettle();
      const again = pageOf(await getChanges(apiHost, token, { cursor: first.cursor }));
      expect(again).toMatchObject({ changes: [], hasMore: false });
      for (const body of [...first.pages, again]) expect(JSON.stringify(body)).not.toContain(climber.userId);
    });

    it('includes ticks the climber keeps to "only me" (decision 21)', async () => {
      const { climber, token } = await connectedApp();
      const [onlyMe] = await insertTicks(climber.userId, 1);
      await db
        .insert(contentPrivacy)
        .values({ entityType: 'tick', entityId: onlyMe, ownerId: climber.userId, audience: 'only_me' });
      const { copy } = await sync(token);
      expect(copy.has(onlyMe)).toBe(true);
      expect((await apiHost.send('GET', `/v1/logbook/ticks/${onlyMe}`, { token })).status).toBe(200);
    });

    it('gives two climbers in one board session only their own ticks', async () => {
      const first = await connectedApp();
      const second = await connectedApp();
      const sessionId = `lb-api-session-${randomUUID()}`;
      await db.execute(sql`
        INSERT INTO board_sessions (id, board_path, created_by_user_id, status)
        VALUES (${sessionId}, 'kilter/1/10/1/40', ${first.climber.userId}, 'active')
      `);
      const firstTicks = await insertTicks(first.climber.userId, 2, { sessionId });
      const secondTicks = await insertTicks(second.climber.userId, 2, { sessionId });

      expect([...(await sync(first.token)).copy.keys()].sort()).toEqual([...firstTicks].sort());
      expect([...(await sync(second.token)).copy.keys()].sort()).toEqual([...secondTicks].sort());
      errorOf(
        await apiHost.send('GET', `/v1/logbook/ticks/${secondTicks[0]}`, { token: first.token }),
        404,
        'not_found',
      );
    });
  });

  describe('cursors', () => {
    it.each([
      ['0', 0],
      ['201', 201],
      ['not a number', 'abc'],
    ])('refuses a limit of %s with invalid_request naming the field', async (_label, limit) => {
      const { token } = await connectedApp();
      const body = errorOf(
        await apiHost.send('GET', `${CHANGES_PATH}?limit=${encodeURIComponent(String(limit))}`, { token }),
        400,
        'invalid_request',
      );
      expect(body.field).toBe('limit');
    });

    it('answers c3.expired with 410 cursor_expired, always', async () => {
      const { token } = await connectedApp();
      errorOf(await getChanges(apiHost, token, { cursor: 'c3.expired' }), 410, 'cursor_expired');
    });

    it.each([
      ['junk', 'not-a-cursor'],
      ['the docs example', 'c3.eyJraW5kIjo'],
    ])('refuses %s with 400 invalid_cursor', async (_label, cursor) => {
      const { token } = await connectedApp();
      const body = errorOf(await getChanges(apiHost, token, { cursor }), 400, 'invalid_cursor');
      expect(body.field).toBe('cursor');
    });

    it('refuses a cursor with one character changed', async () => {
      const { climber, token } = await connectedApp();
      await insertTicks(climber.userId, 1);
      const { cursor } = await sync(token);
      const middle = Math.floor(cursor.length / 2) + 5;
      const tampered = `${cursor.slice(0, middle)}${cursor[middle] === 'A' ? 'B' : 'A'}${cursor.slice(middle + 1)}`;
      errorOf(await getChanges(apiHost, token, { cursor: tampered }), 400, 'invalid_cursor');
    });

    it("answers 410 for another app's cursor, even for the same climber", async () => {
      const first = await connectedApp();
      const second = await connectedApp(LOGBOOK_SCOPES, first.climber);
      await insertTicks(first.climber.userId, 1);
      const { cursor } = await sync(first.token);
      errorOf(await getChanges(apiHost, second.token, { cursor }), 410, 'cursor_expired');
    });

    it('answers 410 for a cursor from before a reconnect', async () => {
      const { client, climber, token } = await connectedApp();
      await insertTicks(climber.userId, 1);
      const { cursor } = await sync(token);
      expect((await apiHost.send('DELETE', '/v1/connection', { token })).status).toBe(204);
      const reconnected = await reconnect(client);
      expect((await connectionOf(client)).generation).toBe(1);
      errorOf(await getChanges(apiHost, reconnected, { cursor }), 410, 'cursor_expired');
      expect((await sync(reconnected)).copy.size).toBe(1);
    });

    it('answers 410 for a cursor from another feed generation', async () => {
      const { climber, token } = await connectedApp();
      await insertTicks(climber.userId, 1);
      const { cursor } = await sync(token);
      await db.update(logbookChangeWatermark).set({ feedGeneration: sql`gen_random_uuid()` });
      errorOf(await getChanges(apiHost, token, { cursor }), 410, 'cursor_expired');
      expect((await sync(token)).copy.size).toBe(1);
    });

    it('answers 410 for a cursor below the pruned horizon', async () => {
      const { climber, token } = await connectedApp();
      await insertTicks(climber.userId, 1);
      const { cursor } = await sync(token);
      await db.update(logbookChangeWatermark).set({ prunedThroughTxid: '9999999999999', prunedThroughSeq: 1n });
      try {
        errorOf(await getChanges(apiHost, token, { cursor }), 410, 'cursor_expired');
      } finally {
        await db.update(logbookChangeWatermark).set({ prunedThroughTxid: '0', prunedThroughSeq: 0n });
      }
    });

    it('answers 410 exactly below the watermark a real prune set, and serves a cursor at it in full', async () => {
      const { climber, token } = await connectedApp();
      await insertTicks(climber.userId, 1);
      // Settled first, so the sync ends past this tick's change. Otherwise a
      // transaction open anywhere on this Postgres holds the horizon below it,
      // the sync ends there, and the next page serves this tick again, ahead of
      // the three below.
      await waitForWritesToSettle();
      const { cursor: caughtUp } = await sync(token);
      // Three more, each its own transaction, so each change has its own position.
      const added: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        added.push(...(await insertTicks(climber.userId, 1, { climbUuid: `lb-api-prune-${index}` })));
      }
      await waitForWritesToSettle();
      const throughFirst = pageOf(await getChanges(apiHost, token, { cursor: caughtUp, limit: 1 }));
      const throughSecond = pageOf(await getChanges(apiHost, token, { cursor: throughFirst.cursor, limit: 1 }));
      const idsOf = (body: LogbookChangesResponse) =>
        body.changes.map((change) => (change.type === 'tick' ? change.tick.id : change.id));
      expect([...idsOf(throughFirst), ...idsOf(throughSecond)]).toEqual(added.slice(0, 2));

      // Every change up to the second tick's ages out, and a real prune runs.
      const [secondChange] = await db
        .select({ seq: logbookChanges.seq })
        .from(logbookChanges)
        .where(eq(logbookChanges.tickUuid, added[1]));
      await db
        .update(logbookChanges)
        .set({ createdAt: sql`localtimestamp - interval '91 days'` })
        .where(lte(logbookChanges.seq, secondChange.seq));
      await waitForWritesToSettle();
      const pruned = await pruneLogbookChanges({
        read: (callback) => db.transaction(callback),
        runBatch: (callback) => db.transaction(callback),
      });

      // The watermark is exactly the second tick's change, the cursor the app holds.
      const decoded = decodeLogbookCursor(throughSecond.cursor, TEST_CONFIGURATION.secrets);
      if (decoded.status !== 'ok' || decoded.cursor.kind !== 'changes') throw new Error('expected a change cursor');
      const atWatermark = decoded.cursor;
      expect(pruned.prunedThrough).toEqual({ txid: atWatermark.txid, seq: atWatermark.seq });
      expect(BigInt(atWatermark.txid)).toBeGreaterThan(0n);

      // At the watermark, and one seq past it: the third tick, nothing missing.
      expect(idsOf(pageOf(await getChanges(apiHost, token, { cursor: throughSecond.cursor })))).toEqual([added[2]]);
      const reseal = (seq: bigint) =>
        encodeLogbookCursor({ ...atWatermark, seq: String(seq) }, TEST_CONFIGURATION.secrets);
      expect(idsOf(pageOf(await getChanges(apiHost, token, { cursor: reseal(BigInt(atWatermark.seq) + 1n) })))).toEqual(
        [added[2]],
      );
      // One seq below it, and every cursor before it: the second tick's change is gone.
      errorOf(
        await getChanges(apiHost, token, { cursor: reseal(BigInt(atWatermark.seq) - 1n) }),
        410,
        'cursor_expired',
      );
      errorOf(await getChanges(apiHost, token, { cursor: throughFirst.cursor }), 410, 'cursor_expired');
      errorOf(await getChanges(apiHost, token, { cursor: caughtUp }), 410, 'cursor_expired');
      // Starting over still gives the whole logbook.
      expect((await sync(token)).copy.size).toBe(4);
    });

    it('answers 410 for a snapshot cursor once its snapshot is gone', async () => {
      const { climber, token } = await connectedApp();
      await insertTicks(climber.userId, 3);
      const first = pageOf(await getChanges(apiHost, token, { limit: 1 }));
      expect(first.hasMore).toBe(true);
      await db
        .update(logbookSnapshots)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(logbookSnapshots.userId, climber.userId));
      errorOf(await getChanges(apiHost, token, { cursor: first.cursor }), 410, 'cursor_expired');
    });
  });

  describe('the snapshot build', () => {
    it('answers an empty page while the build cannot run, and drives the build on the next call', async () => {
      const { climber, token } = await connectedApp();
      const tickIds = await insertTicks(climber.userId, 4);
      const slots = await holdBuildSlots();
      let waiting: LogbookChangesResponse;
      try {
        waiting = pageOf(await getChanges(apiHost, token));
        expect(waiting).toMatchObject({ changes: [], hasMore: true });
        const [row] = await db.select().from(logbookSnapshots).where(eq(logbookSnapshots.userId, climber.userId));
        expect(row.status).toBe('building');
      } finally {
        await slots.release();
      }
      const resumed = await sync(token, waiting.cursor);
      expect([...resumed.copy.keys()].sort()).toEqual([...tickIds].sort());
    });

    it('answers a statement or lock timeout with an empty page at the same cursor', async () => {
      const { climber, token } = await connectedApp();
      await insertTicks(climber.userId, 3);
      const snapshotPage = pageOf(await getChanges(apiHost, token, { limit: 1 }));
      const { cursor: changeCursor } = await sync(token, snapshotPage.cursor);

      for (const code of ['57014', '55P03']) {
        const timingOut = await hostWithLogbookDatabases(failingDatabase(code), failingDatabase(code));
        expect(pageOf(await getChanges(timingOut, token, { cursor: changeCursor }))).toEqual({
          changes: [],
          cursor: changeCursor,
          hasMore: true,
        });
        expect(pageOf(await getChanges(timingOut, token, { cursor: snapshotPage.cursor }))).toMatchObject({
          changes: [],
          hasMore: true,
        });
        // A single tick has no empty page to give.
        const tick = await timingOut.send('GET', `/v1/logbook/ticks/${randomUUID()}`, { token });
        errorOf(tick, 503, 'server_error');
        expect(tick.headers['retry-after']).toBe('2');
      }
    });

    it('answers a start that cannot get its locks with 503 and Retry-After', async () => {
      const { token } = await connectedApp();
      const busy = await hostWithLogbookDatabases(db, failingDatabase('55P03'));
      const answered = await getChanges(busy, token);
      errorOf(answered, 503, 'server_error');
      expect(answered.headers['retry-after']).toBe('2');
    });

    it.each(['too_large', 'stalled'] as const)(
      'treats a %s build as over: 503 until its verdict lapses, for the cursor and for a restart',
      async (verdict) => {
        const { climber, token } = await connectedApp();
        await insertTicks(climber.userId, 2);
        const slots = await holdBuildSlots();
        let waiting: LogbookChangesResponse;
        try {
          waiting = pageOf(await getChanges(apiHost, token));
        } finally {
          await slots.release();
        }
        await db
          .update(logbookSnapshots)
          .set({ status: verdict, expiresAt: sql`now() + interval '1 hour'` })
          .where(eq(logbookSnapshots.userId, climber.userId));

        for (const query of [{ cursor: waiting.cursor }, {}]) {
          const answered = await getChanges(apiHost, token, query);
          errorOf(answered, 503, 'server_error');
          expect(Number(answered.headers['retry-after'])).toBeGreaterThan(3500);
          expect(Number(answered.headers['retry-after'])).toBeLessThanOrEqual(3600);
        }
        expect(
          await db.select().from(logbookSnapshots).where(eq(logbookSnapshots.userId, climber.userId)),
        ).toHaveLength(1);
      },
    );

    it('answers 503 with Retry-After when snapshot storage is full, and still serves the feed', async () => {
      const full = await connectedApp();
      await insertTicks(full.climber.userId, 1);
      const { cursor } = await sync(full.token);
      const [held] = await db
        .update(logbookSnapshots)
        .set({ tickCount: 25_000_000 })
        .where(eq(logbookSnapshots.userId, full.climber.userId))
        .returning({ id: logbookSnapshots.id });
      try {
        const { token } = await connectedApp();
        const refused = await getChanges(apiHost, token);
        errorOf(refused, 503, 'server_error');
        expect(refused.headers['retry-after']).toBe('900');
        expect(pageOf(await getChanges(apiHost, full.token, { cursor })).hasMore).toBe(false);
      } finally {
        await db.update(logbookSnapshots).set({ tickCount: 1 }).where(eq(logbookSnapshots.id, held.id));
      }
    });

    it('never holds a /v1 permit while snapshot work runs', { timeout: 30_000 }, async () => {
      const slowSnapshots = databaseRunningFirst(() => new Promise((resolve) => setTimeout(resolve, 1500)));
      const host = await hostWithLogbookDatabases(db, slowSnapshots);
      const apps = await Promise.all([connectedApp(), connectedApp(), connectedApp(['profile:read'])]);
      const snapshots = [getChanges(host, apps[0].token), getChanges(host, apps[1].token)];
      await new Promise((resolve) => setTimeout(resolve, 200));
      const startedAt = Date.now();
      const others = await Promise.all(
        Array.from({ length: 3 }, () => host.send('GET', '/v1/me', { token: apps[2].token })),
      );
      expect(Date.now() - startedAt).toBeLessThan(1000);
      for (const other of others) expect(other.status).toBe(200);
      for (const answered of await Promise.all(snapshots)) expect(answered.status).toBe(200);
    });
  });

  describe('the snapshot creation limit', () => {
    it('counts only real creations, and refuses a creation over 2 a minute with 429', { timeout: 40_000 }, async () => {
      await enoughWindowLeft();
      const { client, climber, token } = await connectedApp();
      await insertTicks(climber.userId, 1);
      const identity = `${client.clientId}:${climber.userId}`;

      const slots = await holdBuildSlots();
      try {
        pageOf(await getChanges(apiHost, token));
        expect(await limiterCount(identity, 'api-snapshot-create')).toBe(1);
        // A retry joins the build that exists: free, and never refused.
        await seedLimiter(identity, 'api-snapshot-create', 2);
        pageOf(await getChanges(apiHost, token));
        expect(await limiterCount(identity, 'api-snapshot-create')).toBe(2);
      } finally {
        await slots.release();
      }

      await db
        .update(logbookSnapshots)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(logbookSnapshots.userId, climber.userId));
      const refused = await getChanges(apiHost, token);
      errorOf(refused, 429, 'rate_limited');
      expect(refused.headers['ratelimit-limit']).toBe('2');
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      // Nothing new was created: the one row is the expired build.
      expect(await db.select().from(logbookSnapshots).where(eq(logbookSnapshots.userId, climber.userId))).toHaveLength(
        1,
      );
    });
  });

  describe('scope and the climber', () => {
    it('refuses a token without logbook:read with 403 insufficient_scope on both routes', async () => {
      const { climber, token } = await connectedApp(['profile:read', 'offline_access']);
      const [tickId] = await insertTicks(climber.userId, 1);
      for (const path of [CHANGES_PATH, `/v1/logbook/ticks/${tickId}`]) {
        const refused = await apiHost.send('GET', path, { token });
        errorOf(refused, 403, 'insufficient_scope');
        expect(refused.headers['www-authenticate']).toBe('Bearer error="insufficient_scope", scope="logbook:read"');
      }
      expect(await db.select().from(logbookSnapshots).where(eq(logbookSnapshots.userId, climber.userId))).toHaveLength(
        0,
      );
    });

    it('answers 401 when the connection ends between the token check and the page', async () => {
      const { client, climber, token } = await connectedApp();
      await insertTicks(climber.userId, 1);
      const { cursor } = await sync(token);
      const endsFirst = databaseRunningFirst(async () => {
        await db
          .update(oauthConnections)
          .set({ revokedAt: new Date(), generation: sql`${oauthConnections.generation} + 1` })
          .where(eq(oauthConnections.id, (await connectionOf(client)).id));
      });
      const host = await hostWithLogbookDatabases(endsFirst, endsFirst);
      const ended = await getChanges(host, token, { cursor });
      errorOf(ended, 401, 'invalid_token');
      expect(ended.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    });

    it('answers 401 on the next request after a Disconnect, and a reconnect starts again', async () => {
      const { client, climber, token } = await connectedApp();
      await insertTicks(climber.userId, 1);
      const { cursor } = await sync(token);
      expect((await apiHost.send('DELETE', '/v1/connection', { token })).status).toBe(204);
      errorOf(await getChanges(apiHost, token, { cursor }), 401, 'invalid_token');
      const reconnected = await reconnect(client);
      expect((await sync(reconnected)).copy.size).toBe(1);
    });
  });

  describe('GET /v1/logbook/ticks/{id}', () => {
    it("serves one of the climber's ticks in the tick shape", async () => {
      const { climber, token } = await connectedApp();
      const [tickId] = await insertTicks(climber.userId, 1, { comment: '' });
      const answered = await apiHost.send('GET', `/v1/logbook/ticks/${tickId}`, { token });
      expect(answered.status).toBe(200);
      const tick = TickSchema.parse(JSON.parse(answered.body));
      expect(tick).toMatchObject({ id: tickId, status: 'send', attempts: 2, comment: null });
      expect(answered.body).not.toContain(climber.userId);
    });

    it('answers 404 not_found for a deleted tick, a hidden twin, junk and an unknown id', async () => {
      const { climber, token } = await connectedApp();
      const [deleted] = await insertTicks(climber.userId, 1);
      await db.delete(boardseshTicks).where(eq(boardseshTicks.uuid, deleted));
      const twinFields = {
        origin: 'aurora_pull' as const,
        auroraType: 'ascents' as const,
        climbUuid: 'lb-api-twin',
        climbedAt: '2026-05-02 09:00:00',
        updatedAt: '2026-05-02 09:00:00',
        auroraSyncedAt: '2026-05-02 09:00:00',
      };
      const [survivor] = await insertTicks(climber.userId, 1, { ...twinFields, auroraId: `a-${randomUUID()}` });
      const [twin] = await insertTicks(climber.userId, 1, { ...twinFields, auroraId: `b-${randomUUID()}` });
      const served = await Promise.all(
        [survivor, twin].map(async (id) => (await apiHost.send('GET', `/v1/logbook/ticks/${id}`, { token })).status),
      );
      expect(served.sort((left, right) => left - right)).toEqual([200, 404]);
      for (const id of [deleted, 'not%20an%20id', randomUUID()]) {
        errorOf(await apiHost.send('GET', `/v1/logbook/ticks/${id}`, { token }), 404, 'not_found');
      }
    });
  });

  describe('climb metadata', () => {
    let wallSequence = 0;

    async function seedSprayWall(ownerId: string, { isPublic }: { isPublic: boolean }) {
      wallSequence += 1;
      const wallUuid = `lb-api-wall-${process.pid}-${wallSequence}-${randomUUID()}`;
      const layoutId = 880_000 + Math.floor(Math.random() * 100_000);
      const climbUuid = `lb-api-spray-climb-${randomUUID()}`;
      await db.execute(sql`
        INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, has_leds)
        VALUES (${wallUuid}, ${wallUuid}, ${ownerId}, 'spray', ${layoutId}, ${layoutId}, '1', 'Garage wall', ${isPublic}, false)
      `);
      await db.execute(sql`INSERT INTO spray_walls (board_uuid, layout_id) VALUES (${wallUuid}, ${layoutId})`);
      await db.execute(
        sql`INSERT INTO board_layouts (board_type, id, name) VALUES ('spray', ${layoutId}, 'Garage wall')`,
      );
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, frames_count, is_draft, is_listed, created_at)
        VALUES (${climbUuid}, 'spray', ${layoutId}, 'Couch traverse', 'p1r1', 1, false, true, '2026-01-01')
      `);
      return { wallUuid, climbUuid };
    }

    async function onlyTick(token: string): Promise<Tick> {
      const ticks = [...(await sync(token)).copy.values()];
      expect(ticks).toHaveLength(1);
      return ticks[0];
    }

    it("serves the climb name, layout and community grade at the tick's angle, and no Boardsesh grade", async () => {
      const { climber, token } = await connectedApp();
      const layoutId = 770_000 + Math.floor(Math.random() * 100_000);
      const climbUuid = `lb-api-kilter-${randomUUID()}`;
      await db.execute(
        sql`INSERT INTO board_layouts (board_type, id, name) VALUES ('kilter', ${layoutId}, 'Kilter Board Original')`,
      );
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, frames_count, is_draft, is_listed, created_at)
        VALUES (${climbUuid}, 'kilter', ${layoutId}, 'Slopey Business', 'p1r1', 1, false, true, '2026-01-01')
      `);
      await db.execute(sql`
        INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty)
        VALUES ('kilter', ${climbUuid}, 40, 18.6), ('kilter', ${climbUuid}, 50, 25)
      `);
      await db.execute(sql`
        INSERT INTO board_climb_grades (board_type, climb_uuid, angle, universal_grade, confidence, model_version, coeff_version)
        VALUES ('kilter', ${climbUuid}, 40, 19.5, 'confirmed', 'test', 'test')
      `);
      await insertTicks(climber.userId, 1, { climbUuid, difficulty: 20, angle: 40 });

      expect((await onlyTick(token)).climb).toEqual({
        id: climbUuid,
        name: 'Slopey Business',
        board: { type: 'kilter', layout: 'Kilter Board Original' },
        grade: { v: 4, font: '6B+', label: '6b+/V4' },
        // A grade row exists, but no V-scale conversion is documented, so none is sent.
        boardseshGrade: null,
      });
    });

    /** A climb set by `setterId`, published, draft or unlisted, with a community grade at 40 degrees. */
    async function seedClimb(setterId: string, state: 'published' | 'draft' | 'unlisted') {
      const climbUuid = `lb-api-${state}-${randomUUID()}`;
      const layoutId = 660_000 + Math.floor(Math.random() * 100_000);
      await db.execute(
        sql`INSERT INTO board_layouts (board_type, id, name) VALUES ('kilter', ${layoutId}, ${`Layout of ${state}`})`,
      );
      await db.execute(sql`
        INSERT INTO board_climbs (uuid, board_type, layout_id, name, frames, frames_count, is_draft, is_listed, user_id, created_at)
        VALUES (${climbUuid}, 'kilter', ${layoutId}, ${`Climb ${state}`}, 'p1r1', 1, ${state === 'draft'},
                ${state !== 'unlisted'}, ${setterId}, '2026-01-01')
      `);
      await db.execute(sql`
        INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty)
        VALUES ('kilter', ${climbUuid}, 40, 19)
      `);
      return climbUuid;
    }

    /** What every case below must serve: the whole climb, nothing withheld. */
    function wholeClimb(climbUuid: string, state: 'published' | 'draft' | 'unlisted') {
      return {
        id: climbUuid,
        name: `Climb ${state}`,
        board: { type: 'kilter', layout: `Layout of ${state}` },
        grade: { v: 4, font: '6B+', label: '6b+/V4' },
        boardseshGrade: null,
      };
    }

    // Owner decision (2026-11-10): an app the climber connected sees every climb
    // they have logged, whoever set it and whether or not it is published. The
    // four cases below pin that; only the spray-wall rule withholds anything.
    it("serves the climber's own draft and own unlisted climbs in full", async () => {
      const { climber, token } = await connectedApp();
      const draft = await seedClimb(climber.userId, 'draft');
      const unlisted = await seedClimb(climber.userId, 'unlisted');
      const [draftTick] = await insertTicks(climber.userId, 1, { climbUuid: draft });
      const [unlistedTick] = await insertTicks(climber.userId, 1, { climbUuid: unlisted });

      const { copy } = await sync(token);
      expect(copy.get(draftTick)?.climb).toEqual(wholeClimb(draft, 'draft'));
      expect(copy.get(unlistedTick)?.climb).toEqual(wholeClimb(unlisted, 'unlisted'));
      const single = await apiHost.send('GET', `/v1/logbook/ticks/${draftTick}`, { token });
      expect(single.status).toBe(200);
      expect(TickSchema.parse(JSON.parse(single.body)).climb).toEqual(wholeClimb(draft, 'draft'));
    });

    it("serves a tick on someone else's draft or unlisted climb in full: snapshot, feed and tick route", async () => {
      const setter = await environment.createClimber();
      const { climber, token } = await connectedApp();
      const draft = await seedClimb(setter.userId, 'draft');
      const unlisted = await seedClimb(setter.userId, 'unlisted');
      const [draftTick] = await insertTicks(climber.userId, 1, { climbUuid: draft });
      const [unlistedTick] = await insertTicks(climber.userId, 1, { climbUuid: unlisted });
      await waitForWritesToSettle();

      const first = await sync(token);
      expect(first.copy.get(draftTick)?.climb).toEqual(wholeClimb(draft, 'draft'));
      expect(first.copy.get(unlistedTick)?.climb).toEqual(wholeClimb(unlisted, 'unlisted'));

      // A new tick on such a climb reaches the feed as a tick, not a removal.
      const [laterTick] = await insertTicks(climber.userId, 1, {
        climbUuid: unlisted,
        climbedAt: '2026-06-01 10:00:00',
      });
      await waitForWritesToSettle();
      const caughtUp = await sync(token, first.cursor);
      const changes = caughtUp.pages.flatMap((body) => body.changes);
      expect(changes).not.toContainEqual({ type: 'tick.deleted', id: laterTick });
      expect(caughtUp.copy.get(laterTick)?.climb).toEqual(wholeClimb(unlisted, 'unlisted'));

      for (const [tickId, climbUuid, state] of [
        [draftTick, draft, 'draft'],
        [unlistedTick, unlisted, 'unlisted'],
      ] as const) {
        const single = await apiHost.send('GET', `/v1/logbook/ticks/${tickId}`, { token });
        expect(single.status).toBe(200);
        expect(TickSchema.parse(JSON.parse(single.body)).climb).toEqual(wholeClimb(climbUuid, state));
      }
    });

    it('serves a published climb whose setter keeps a private account in full', async () => {
      const setter = await environment.createClimber();
      await db.insert(userProfiles).values({ userId: setter.userId, isPrivate: true });
      const { climber, token } = await connectedApp();
      const published = await seedClimb(setter.userId, 'published');
      const [tickId] = await insertTicks(climber.userId, 1, { climbUuid: published });

      expect((await onlyTick(token)).climb).toEqual(wholeClimb(published, 'published'));
      expect((await apiHost.send('GET', `/v1/logbook/ticks/${tickId}`, { token })).status).toBe(200);
    });

    it('keeps serving a tick when its climb goes back to draft', async () => {
      const setter = await environment.createClimber();
      const { climber, token } = await connectedApp();
      const climbUuid = await seedClimb(setter.userId, 'published');
      const [tickId] = await insertTicks(climber.userId, 1, { climbUuid });
      expect((await apiHost.send('GET', `/v1/logbook/ticks/${tickId}`, { token })).status).toBe(200);

      await db.execute(sql`UPDATE board_climbs SET is_draft = true WHERE uuid = ${climbUuid}`);
      const single = await apiHost.send('GET', `/v1/logbook/ticks/${tickId}`, { token });
      expect(single.status).toBe(200);
      expect(TickSchema.parse(JSON.parse(single.body)).climb).toMatchObject({ id: climbUuid, name: 'Climb published' });
    });

    it("shows a spray climb's names for the climber's own wall and for a public one", async () => {
      const own = await connectedApp();
      const ownWall = await seedSprayWall(own.climber.userId, { isPublic: false });
      await insertTicks(own.climber.userId, 1, { boardType: 'spray', climbUuid: ownWall.climbUuid });
      expect((await onlyTick(own.token)).climb).toMatchObject({
        name: 'Couch traverse',
        board: { type: 'spray', layout: 'Garage wall' },
      });

      const visitor = await connectedApp();
      const publicWall = await seedSprayWall((await environment.createClimber()).userId, { isPublic: true });
      await insertTicks(visitor.climber.userId, 1, { boardType: 'spray', climbUuid: publicWall.climbUuid });
      expect((await onlyTick(visitor.token)).climb).toMatchObject({
        name: 'Couch traverse',
        board: { layout: 'Garage wall' },
      });
    });

    it("withholds the names of someone else's wall made private after the snapshot was built", async () => {
      const visitor = await connectedApp();
      const wall = await seedSprayWall((await environment.createClimber()).userId, { isPublic: true });
      // Copied first, so the first page of one tick is this one and the spray tick waits for page two.
      const [plainTickId] = await insertTicks(visitor.climber.userId, 1);
      const [tickId] = await insertTicks(visitor.climber.userId, 1, { boardType: 'spray', climbUuid: wall.climbUuid });

      // The whole snapshot is built while the wall is public; then it goes private before page two is read.
      const firstPage = pageOf(await getChanges(apiHost, visitor.token, { limit: 1 }));
      expect(firstPage.changes).toEqual([
        expect.objectContaining({ tick: expect.objectContaining({ id: plainTickId }) }),
      ]);
      const [snapshot] = await db
        .select()
        .from(logbookSnapshots)
        .where(eq(logbookSnapshots.userId, visitor.climber.userId));
      expect(snapshot).toMatchObject({ status: 'ready', tickCount: 2 });
      await db.execute(sql`UPDATE user_boards SET is_public = false WHERE uuid = ${wall.wallUuid}`);
      const { copy } = await sync(visitor.token, firstPage.cursor);

      const tick = copy.get(tickId);
      expect(tick?.climb).toMatchObject({ name: null, board: { type: 'spray', layout: 'Spray wall' } });
      const single = await apiHost.send('GET', `/v1/logbook/ticks/${tickId}`, { token: visitor.token });
      expect(single.body).not.toContain('Couch traverse');
      expect(single.body).not.toContain('Garage wall');
    });
  });

  describe('limits and CORS', () => {
    it(
      'charges the connection and the app once the token has passed, like every /v1 route',
      { timeout: 40_000 },
      async () => {
        await enoughWindowLeft();
        const { client, climber, token } = await connectedApp();
        const answered = await getChanges(apiHost, token);
        expect(answered.status).toBe(200);
        expect(answered.headers['ratelimit-limit']).toBe('120');
        expect(await limiterCount(`${client.clientId}:${climber.userId}`, 'api-connection')).toBe(1);
        expect(await limiterCount(client.clientId, 'api-app')).toBe(1);
      },
    );

    it("never refuses a valid token for a neighbour's failed lookups", { timeout: 40_000 }, async () => {
      await enoughWindowLeft();
      const clientIp = randomClientIp();
      await seedLimiter(clientIp, 'api-invalid-token-ip', 600);
      const { token } = await connectedApp();
      expect((await getChanges(apiHost, token, {}, { clientIp })).status).toBe(200);
      errorOf(
        await getChanges(apiHost, `junk${randomUUID().replaceAll('-', '')}`, {}, { clientIp }),
        429,
        'rate_limited',
      );
    });

    it('answers a preflight for both routes from a registered origin, and shows success to that app only', async () => {
      const appOrigin = `https://logbook-app-${randomUUID()}.example.test`;
      const client = await environment.createClient({ publicClient: true, redirectOrigin: appOrigin });
      runtime.registeredOrigins.invalidate();
      for (const path of [CHANGES_PATH, `/v1/logbook/ticks/${randomUUID()}`]) {
        const preflight = await apiHost.send('OPTIONS', path, { headers: { Origin: appOrigin } });
        expect(preflight.status).toBe(204);
        expect(preflight.headers['access-control-allow-origin']).toBe(appOrigin);
        expect(preflight.headers['access-control-allow-headers']).toContain('Authorization');
      }
      const issued = await environment.issueTokens(client, LOGBOOK_SCOPES);
      const answered = await getChanges(apiHost, issued.access_token, {}, { headers: { Origin: appOrigin } });
      expect(answered.status).toBe(200);
      expect(answered.headers['access-control-allow-origin']).toBe(appOrigin);
      expect(answered.headers['access-control-allow-credentials']).toBeUndefined();
    });
  });

  describe('GET /v1/openapi.json', () => {
    it('serves the committed document to anyone, with no token and no database', async () => {
      const answered = await apiHost.send('GET', '/v1/openapi.json');
      expect(answered.status).toBe(200);
      expect(answered.body).toBe(renderPublicApiDocument());
      expect(answered.headers['content-type']).toBe('application/json; charset=utf-8');
      expect(answered.headers['access-control-allow-origin']).toBe('*');
      const document = JSON.parse(answered.body) as { paths: Record<string, unknown> };
      expect(Object.keys(document.paths)).toEqual([
        '/v1/me',
        '/v1/connection',
        '/v1/logbook/changes',
        '/v1/logbook/ticks/{id}',
      ]);
    });

    it('answers 503 with the rest of the API while the mode is hold', async () => {
      const loadRuntime = vi.fn(async () => runtime);
      const held = await startApiHost({ mode: 'hold', loadRuntime });
      extraHosts.push(held);
      for (const path of ['/v1/openapi.json', CHANGES_PATH, '/v1/logbook/ticks/abc']) {
        const answered = await held.send('GET', path, { token: 'whatever' });
        expect(answered.status).toBe(503);
        expect(answered.headers['retry-after']).toBe('60');
      }
      expect(loadRuntime).not.toHaveBeenCalled();
    });
  });

  it('bounds every page read: 5 s statements, 2 s lock waits, 10 s idle, read-only REPEATABLE READ', async () => {
    const { climber, token } = await connectedApp();
    const [tickId] = await insertTicks(climber.userId, 1);
    const { cursor } = await sync(token);
    const [connection] = await db.select().from(oauthConnections).where(eq(oauthConnections.userId, climber.userId));
    const [snapshot] = await db.select().from(logbookSnapshots).where(eq(logbookSnapshots.userId, climber.userId));
    const seen: Array<Record<string, string>> = [];
    const recordSettings: LogbookPageReader = async (transaction) => {
      const [settings] = (await transaction.execute(sql`
        SELECT current_setting('statement_timeout') AS statement,
               current_setting('lock_timeout') AS lock,
               current_setting('idle_in_transaction_session_timeout') AS idle,
               current_setting('transaction_read_only') AS read_only,
               current_setting('transaction_isolation') AS isolation
      `)) as unknown as Array<Record<string, string>>;
      seen.push(settings);
    };

    const decoded = decodeLogbookCursor(cursor, TEST_CONFIGURATION.secrets);
    if (decoded.status !== 'ok' || decoded.cursor.kind !== 'changes') throw new Error('expected a change cursor');
    const { feedGeneration, txid, seq } = decoded.cursor;
    await readLogbookFeedPage(db, {
      userId: climber.userId,
      cursor: { generation: feedGeneration, txid, seq },
      limit: 10,
      withinRead: recordSettings,
    });
    await readLogbookTick(db, { userId: climber.userId, tickUuid: tickId, withinRead: recordSettings });
    await readLogbookSnapshotPage(db, {
      binding: { userId: climber.userId, connectionId: connection.id, connectionGeneration: connection.generation },
      cursor: { snapshotId: snapshot.id, position: 0 },
      limit: 10,
      withinRead: recordSettings,
    });

    expect(seen).toEqual(
      Array.from({ length: 3 }, () => ({
        statement: '5s',
        lock: '2s',
        idle: '10s',
        read_only: 'on',
        isolation: 'repeatable read',
      })),
    );
  });

  it('treats a cursor sealed under a secret version this runtime does not hold as retired', async () => {
    const { climber, token } = await connectedApp();
    await insertTicks(climber.userId, 1);
    const { cursor } = await sync(token);
    const resealed = encodeLogbookCursor(
      {
        kind: 'snapshot',
        connectionId: (await db.select().from(oauthConnections).where(eq(oauthConnections.userId, climber.userId)))[0]
          .id,
        connectionGeneration: 0,
        snapshotId: randomUUID(),
        position: 0,
      },
      [{ version: 99, value: 'a-secret-this-runtime-has-never-heard-of-0123456789' }],
    );
    // A version this runtime does not hold is treated as retired: start over.
    errorOf(await getChanges(apiHost, token, { cursor: resealed }), 410, 'cursor_expired');
    expect(pageOf(await getChanges(apiHost, token, { cursor })).hasMore).toBe(false);
  });
});
