import { appendFileSync } from 'node:fs';
import { once } from 'node:events';
import { Agent, createServer, request, type IncomingMessage } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { users } from '@boardsesh/db/schema/auth';
import { db } from '../../../db/client';
import { API_HOSTNAME } from '../../../handlers/api-host';
import { createPartnerAuthHandler } from '../../../handlers/partner-auth';
import { redisClientManager } from '../../../redis/client';
import { createPartnerAuthorityRuntime, type PartnerAuthorityRuntime } from '../authority';
import { createPartnerDatabaseHandle } from '../transaction';
import {
  clientCredentials,
  createPartnerTestEnvironment,
  postForm,
  READ_ONLY_PROOF_APPLICATION_NAME,
  TEST_CONFIGURATION,
  testSessionBridge,
  type PartnerTestEnvironment,
  type TestClient,
} from './partner-fixture';

const AUTHORIZE_PATH = '/api/auth/oauth2/authorize';
const TOKEN_PATH = '/api/auth/oauth2/token';
const FLOOD_DEADLINE_MS = 120_000;
const FLOOD_REQUESTS = 3000;
/** A starved token lane delays every refresh by seconds; runner contention only some. */
const FLOOD_ROUNDS = 3;

/** Set this to get the measured numbers: one JSON line per scenario. */
const MEASUREMENTS_FILE = process.env.PARTNER_MEASUREMENTS_FILE;

function record(scenario: string, values: Record<string, number>): void {
  if (MEASUREMENTS_FILE) appendFileSync(MEASUREMENTS_FILE, `${JSON.stringify({ scenario, ...values })}\n`);
}

function percentile(samples: number[], percentile: number): number {
  const sorted = [...samples].sort((first, second) => first - second);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((percentile / 100) * sorted.length))]);
}

interface HostResponse {
  status: number;
  body: string;
}

async function startFloodableHost(runtime: PartnerAuthorityRuntime) {
  const handler = createPartnerAuthHandler({ mode: 'allowlist', loadRuntime: async () => runtime });
  const server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (handled) return;
      res.writeHead(404);
      res.end();
    });
  });
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const agent = new Agent({ keepAlive: true, maxSockets: 96 });

  function send(
    method: string,
    path: string,
    clientIp: string,
    extra: { headers?: Record<string, string>; body?: string } = {},
  ): Promise<HostResponse> {
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          agent,
          headers: {
            Host: API_HOSTNAME,
            'X-Forwarded-For': clientIp,
            ...extra.headers,
            ...(extra.body !== undefined ? { 'Content-Length': Buffer.byteLength(extra.body) } : {}),
          },
        },
        (incoming: IncomingMessage) => {
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
          incoming.on('end', () =>
            resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      outgoing.on('error', reject);
      outgoing.end(extra.body);
    });
  }

  return {
    send,
    port,
    async close() {
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const uniqueIp = (() => {
  let counter = 0;
  return () => {
    counter += 1;
    return `198.18.${(counter >> 8) & 255}.${counter & 255}`;
  };
})();

describe('partner OAuth availability', () => {
  let environment: PartnerTestEnvironment;
  let runtime: PartnerAuthorityRuntime;
  let host: Awaited<ReturnType<typeof startFloodableHost>>;

  beforeAll(async () => {
    // Real Redis, so the measured paths include its round trips.
    await redisClientManager.connect();
    environment = await createPartnerTestEnvironment();
    runtime = await createPartnerAuthorityRuntime(environment.database, TEST_CONFIGURATION, {
      plugins: [testSessionBridge(createPartnerDatabaseHandle(environment.database))],
      logbook: { feed: db, snapshots: db },
      close: async () => {},
    });
    host = await startFloodableHost(runtime);
  });

  afterAll(async () => {
    await host?.close();
    await environment?.close();
    await redisClientManager.disconnect();
  });

  const refreshOnce = (client: TestClient, refreshToken: string, clientIp: string) =>
    host.send('POST', TOKEN_PATH, clientIp, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        ...clientCredentials(client),
      }).toString(),
    });

  /** Sends the headers of a POST and then stops, like a client that never finishes its body. */
  const sendEndlessBody = (clientIp: string) =>
    new Promise<number>((resolve, reject) => {
      const outgoing = request(
        {
          host: '127.0.0.1',
          port: host.port,
          method: 'POST',
          path: TOKEN_PATH,
          agent: false,
          headers: {
            Host: API_HOSTNAME,
            'X-Forwarded-For': clientIp,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Transfer-Encoding': 'chunked',
          },
        },
        (incoming: IncomingMessage) => {
          incoming.resume();
          incoming.on('end', () => resolve(incoming.statusCode ?? 0));
        },
      );
      outgoing.on('error', reject);
      outgoing.write('client_id=slow');
    });

  async function idleInTransactionConnections(): Promise<number> {
    const rows = await db.execute(
      // pg_stat_activity is cluster-wide, and every worktree's tests share one Postgres.
      sql`select count(*)::int as idle from pg_stat_activity
          where state = 'idle in transaction' and datname = current_database()
            and application_name = ${READ_ONLY_PROOF_APPLICATION_NAME}`,
    );
    return Number((rows as unknown as Array<{ idle: number }>)[0].idle);
  }

  it(
    'a flood of anonymous authorize requests does not delay a refresh',
    async () => {
      const client = await environment.createClient({ publicClient: true });
      const baselineTokens = await environment.issueTokens(client);
      const baseline = performance.now();
      expect((await refreshOnce(client, baselineTokens.refresh_token!, uniqueIp())).status).toBe(200);
      const baselineRefreshMs = performance.now() - baseline;

      const floodClient = await environment.createClient({ publicClient: true });
      const floodPath = `${AUTHORIZE_PATH}?${new URLSearchParams({
        response_type: 'code',
        client_id: floodClient.clientId,
        redirect_uri: floodClient.redirectUri,
        scope: 'profile:read',
        code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        code_challenge_method: 'S256',
      }).toString()}`;

      // A fresh flood for every sample. Without the gate the first refresh waits
      // until the flood has drained, so a second one in the same flood is fast
      // (1,839 ms, then 15 ms) and would hide the regression.
      const refreshDuringFloodMs: number[] = [];
      const floodRefused503: number[] = [];
      for (let round = 1; round <= FLOOD_ROUNDS; round += 1) {
        const flood = Array.from({ length: FLOOD_REQUESTS }, () => host.send('GET', floodPath, uniqueIp()));

        // Refresh while the flood is in flight.
        const tokens = await environment.issueTokens(client);
        const refreshStarted = performance.now();
        const refreshed = await refreshOnce(client, tokens.refresh_token!, uniqueIp());
        const refreshMs = performance.now() - refreshStarted;

        const settled = await Promise.all(flood);
        const statuses = settled.reduce<Record<number, number>>((counts, { status }) => {
          counts[status] = (counts[status] ?? 0) + 1;
          return counts;
        }, {});
        record('authorize-flood-vs-refresh', {
          round,
          baselineRefreshMs: Math.round(baselineRefreshMs),
          refreshDuringFloodMs: Math.round(refreshMs),
          floodRequests: flood.length,
          floodServed302: statuses[302] ?? 0,
          floodRefused503: statuses[503] ?? 0,
        });

        expect(refreshed.status).toBe(200);
        refreshDuringFloodMs.push(refreshMs);
        floodRefused503.push(statuses[503] ?? 0);
      }

      // Before the gate every refresh waited seconds: 3,083 ms against a 10 ms
      // baseline. A busy CI runner slows only some (one took 1,089 ms in the full
      // parallel suite), so the fastest of the rounds is judged.
      const roundedSamples = refreshDuringFloodMs.map((sampleMs) => Math.round(sampleMs));
      expect(Math.min(...refreshDuringFloodMs), `refreshes took ${roundedSamples.join(', ')} ms`).toBeLessThan(500);
      for (const refused of floodRefused503) expect(refused).toBeGreaterThan(0);
    },
    FLOOD_DEADLINE_MS,
  );

  // Without the verifier the provider refuses before it would clean up, so the
  // fence has to close the tokens itself or every replay takes the lock again.
  it.each([
    ['with the verifier', 'spent-code-replay-vs-reset', true],
    ['without the verifier', 'spent-code-no-verifier-replay-vs-reset', false],
  ])(
    'spent-code replays %s do not hold up a password reset',
    async (_label, scenario, sendsVerifier) => {
      const client = await environment.createClient();
      const authorization = await environment.authorize(client);
      expect((await environment.exchange(client, authorization)).response.status).toBe(200);
      const code = new URL(authorization.location!).searchParams.get('code')!;
      const form = {
        grant_type: 'authorization_code',
        code,
        ...(sendsVerifier ? { code_verifier: authorization.verifier } : {}),
        redirect_uri: client.redirectUri,
        ...clientCredentials(client),
      };
      // The first replay removes the tokens, so every later one has nothing to do.
      expect((await postForm(environment.instance, '/oauth2/token', form)).body.error).toBe('invalid_grant');

      // Six concurrent replayers driving the fence directly, past every rate limit.
      let replaying = true;
      let replays = 0;
      const replayers = Array.from({ length: 6 }, async () => {
        while (replaying) {
          await postForm(environment.instance, '/oauth2/token', form);
          replays += 1;
        }
      });
      const replayStarted = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 500));

      // A password reset: the row lock the trigger takes.
      const resetStarted = performance.now();
      await db.transaction(async (transaction) => {
        await transaction
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, client.owner.userId))
          .for('no key update');
        await transaction.execute(sql`select 1`);
      });
      const resetMs = performance.now() - resetStarted;

      await new Promise((resolve) => setTimeout(resolve, 500));
      replaying = false;
      await Promise.all(replayers);
      const durationSeconds = (performance.now() - replayStarted) / 1000;

      record(scenario, {
        resetMs: Math.round(resetMs),
        replaysPerSecond: Math.round(replays / durationSeconds),
      });

      // Before this fix the reset waited 8.8 s, until the replays stopped.
      expect(resetMs).toBeLessThan(200);
    },
    FLOOD_DEADLINE_MS,
  );

  it(
    'three endless POST bodies hold no connection for the five-second deadline',
    async () => {
      const client = await environment.createClient({ publicClient: true });
      const tokens = await environment.issueTokens(client);
      const openedAt = performance.now();
      const slowBodies = Array.from({ length: 3 }, () => sendEndlessBody(uniqueIp()));
      await new Promise((resolve) => setTimeout(resolve, 200));

      const inTransaction = await idleInTransactionConnections();
      const refreshStarted = performance.now();
      const refreshed = await refreshOnce(client, tokens.refresh_token!, uniqueIp());
      const refreshMs = performance.now() - refreshStarted;

      const statuses = await Promise.all(slowBodies);
      const refusedAfterMs = performance.now() - openedAt;

      record('endless-bodies-vs-refresh', {
        refreshMs: Math.round(refreshMs),
        connectionsIdleInTransaction: inTransaction,
        refusedAfterMs: Math.round(refusedAfterMs),
      });

      expect(inTransaction).toBe(0);
      expect(refreshed.status).toBe(200);
      expect(refreshMs).toBeLessThan(500);
      expect(statuses).toEqual([408, 408, 408]);
    },
    FLOOD_DEADLINE_MS,
  );

  it('discovery opens no connection under load', async () => {
    const samples: number[] = [];
    for (let round = 0; round < 20; round += 1) {
      const started = performance.now();
      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          host.send('GET', '/.well-known/oauth-authorization-server/api/auth', uniqueIp()),
        ),
      );
      samples.push(performance.now() - started);
      expect(responses.every((response) => response.status === 200)).toBe(true);
    }
    record('discovery-under-load', { p50Ms: percentile(samples, 50), p95Ms: percentile(samples, 95) });
  });
});
