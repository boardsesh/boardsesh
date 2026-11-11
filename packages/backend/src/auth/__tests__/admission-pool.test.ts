import { randomUUID } from 'node:crypto';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import { inArray, sql } from 'drizzle-orm';
import { SignJWT } from 'jose';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createDedicatedPool, createPool, setDbConnectObserver, type DbConnectRetryEvent } from '@boardsesh/db/client';
import { authSubjectCutoffs, users } from '@boardsesh/db/schema/auth';
import { getWorkerDatabaseUrl } from '../../__tests__/worker-db';
import { db } from '../../db/client';
import { validateToken } from '../../middleware/auth';
import { logger } from '../../utils/logger';
import {
  AUTH_ADMISSION_APPLICATION_NAME,
  AUTH_ADMISSION_CONNECT_RETRY_BUDGET_MS,
  AUTH_ADMISSION_CONNECT_TIMEOUT_S,
  AUTH_ADMISSION_DEAD_SOCKET_AFTER_MS,
  AUTH_ADMISSION_POOL_MAX_CONNECTIONS,
  AUTH_ADMISSION_RECYCLE_BACKOFF_MS,
  AUTH_ADMISSION_READ_WATCHDOG_MS,
  AUTH_ADMISSION_STATEMENT_TIMEOUT_MS,
  closeAdmissionPool,
  getAdmissionPool,
  readOnAdmissionConnection,
} from '../admission-pool';
import { MAX_CONCURRENT_COALESCED_ADMISSION_READS } from '../admission-read-coalescer';
import {
  readHumanSubjectStates,
  AUTH_ADMISSION_RESPONSE_DEADLINE_MS,
  AuthAdmissionUnavailableError,
  isHumanSubjectActive,
  MAX_UNSETTLED_AUTH_ADMISSION_READS,
  runAuthAdmissionRead,
} from '../human-admission';

// Real Postgres, real pools. The bug only exists where the driver's queue, the
// pool size and a statement that takes real time all meet, so a mock of `db`
// cannot reproduce it. The worker database comes from setup.ts.

const activeUserId = randomUUID();
const deletedUserId = randomUUID();
const ANSWERED_WELL_INSIDE_DEADLINE_MS = AUTH_ADMISSION_RESPONSE_DEADLINE_MS / 2;

function deferred<Result = void>() {
  let resolve = (_result: Result) => {};
  let reject = (_reason: unknown) => {};
  const promise = new Promise<Result>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function nextEventLoopTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Holds every main-pool connection inside a transaction, as withSerialPlan does. */
async function holdMainPoolFull() {
  // Opening the admission connections is a separate cost; these tests time queueing.
  await readHumanSubjectStates([activeUserId]);
  const mainPoolSize = createPool().options.max;
  const holdersReleased = deferred();
  let heldConnections = 0;
  const holders = Array.from({ length: mainPoolSize }, () =>
    db.transaction(async (transaction) => {
      await transaction.execute(sql`select 1`);
      heldConnections += 1;
      await holdersReleased.promise;
    }),
  );
  await vi.waitFor(() => expect(heldConnections).toBe(mainPoolSize), { timeout: 5000, interval: 10 });
  return {
    release: async () => {
      holdersReleased.resolve();
      await Promise.all(holders);
    },
  };
}

/**
 * Real Postgres behind a TCP proxy that can go silent with its sockets still
 * open, which neither a closed port nor the statement timeout can imitate.
 */
async function startPostgresProxy() {
  const database = new URL(getWorkerDatabaseUrl());
  const openSockets = new Set<Socket>();
  const forwarded: Array<{ clientSide: Socket; databaseSide: Socket }> = [];
  let shouldSwallowNewConnections = false;
  let openDelayMs = 0;
  let shouldFreezeNewConnections = false;

  function track(socket: Socket) {
    openSockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => openSockets.delete(socket));
  }

  function hang({ clientSide, databaseSide }: { clientSide: Socket; databaseSide: Socket }) {
    clientSide.unpipe(databaseSide);
    databaseSide.unpipe(clientSide);
    clientSide.pause();
    databaseSide.pause();
  }

  function forward(clientSide: Socket) {
    if (clientSide.destroyed) return;
    const databaseSide = connect(Number(database.port), database.hostname);
    track(databaseSide);
    clientSide.pipe(databaseSide);
    databaseSide.pipe(clientSide);
    const pair = { clientSide, databaseSide };
    forwarded.push(pair);
    // Answers for 0.1-0.3 s, then goes silent with its sockets open.
    if (shouldFreezeNewConnections) setTimeout(() => hang(pair), 100 + Math.random() * 200);
  }

  const server = createServer((clientSide) => {
    track(clientSide);
    if (shouldSwallowNewConnections) return;
    if (openDelayMs === 0) return forward(clientSide);
    // Holds the startup bytes, as a primary slow to accept a session would.
    clientSide.pause();
    setTimeout(() => forward(clientSide), openDelayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: getWorkerDatabaseUrl().replace(/@[^/]+\//, `@127.0.0.1:${port}/`),
    hangExistingConnections() {
      for (const pair of forwarded.splice(0)) hang(pair);
    },
    hangFirstConnection() {
      const [first] = forwarded.splice(0, 1);
      hang(first);
    },
    setFreezeNewConnections(shouldFreeze: boolean) {
      shouldFreezeNewConnections = shouldFreeze;
    },
    severExistingConnections() {
      for (const { clientSide, databaseSide } of forwarded.splice(0)) {
        clientSide.destroy();
        databaseSide.destroy();
      }
    },
    setSwallowNewConnections(shouldSwallow: boolean) {
      shouldSwallowNewConnections = shouldSwallow;
    },
    setOpenDelayMs(delayMs: number) {
      openDelayMs = delayMs;
    },
    close: async () => {
      for (const socket of openSockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function unusedLocalPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

type Stopwatch = { wallMs: () => number; runningMs: () => number };

/**
 * Something on this machine has paused a test process for up to 6 s at a time; a
 * bare Node interval saw it too. Upper time bounds leave out any pause seen while
 * measuring, so they test the pool rather than the scheduler.
 */
function watchForProcessPauses() {
  const tickMs = 50;
  let lastTickAt = performance.now();
  let pausedMs = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    const lateMs = now - lastTickAt - tickMs;
    if (lateMs > 250) pausedMs += lateMs;
    lastTickAt = now;
  }, tickMs);
  return {
    stopwatch(): Stopwatch {
      const startedAt = performance.now();
      const pausedBeforeMs = pausedMs;
      return {
        wallMs: () => performance.now() - startedAt,
        runningMs: () => performance.now() - startedAt - (pausedMs - pausedBeforeMs),
      };
    },
    stop: () => clearInterval(ticker),
  };
}

async function timed<Result>(operation: () => PromiseLike<Result>) {
  const startedAt = performance.now();
  const result = await operation();
  return { result, elapsedMs: performance.now() - startedAt };
}

describe('auth admission pool', () => {
  const observer = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });

  async function admissionConnectionCount() {
    const [row] = await observer<{ connections: number }[]>`
      SELECT count(*)::int AS connections FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${AUTH_ADMISSION_APPLICATION_NAME}`;
    return row.connections;
  }

  async function runningAdmissionStatements() {
    const [row] = await observer<{ statements: number }[]>`
      SELECT count(*)::int AS statements FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${AUTH_ADMISSION_APPLICATION_NAME}
        AND state = 'active'`;
    return row.statements;
  }

  beforeAll(async () => {
    await db.insert(users).values([
      { id: activeUserId, email: `${activeUserId}@admission.test` },
      { id: deletedUserId, email: `${deletedUserId}@admission.test` },
    ]);
    await db.insert(authSubjectCutoffs).values({
      userId: deletedUserId,
      generation: 1,
      revokedThrough: new Date(),
      deletedAt: new Date(),
      lastOperationId: randomUUID(),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeAdmissionPool();
  });

  afterAll(async () => {
    await db.delete(authSubjectCutoffs).where(inArray(authSubjectCutoffs.userId, [deletedUserId]));
    await db.delete(users).where(inArray(users.id, [activeUserId, deletedUserId]));
    await observer.end();
  });

  describe('with the main pool full', () => {
    it('misses the deadline on the main pool but answers in milliseconds on its own', async () => {
      const mainPool = await holdMainPoolFull();
      try {
        // The path every read took before this pool existed.
        const mainPoolRead = await timed(() =>
          runAuthAdmissionRead(() => db.select({ id: users.id }).from(users).limit(1)).catch((error: unknown) => error),
        );
        expect(mainPoolRead.result).toBeInstanceOf(AuthAdmissionUnavailableError);
        expect(mainPoolRead.elapsedMs).toBeGreaterThanOrEqual(AUTH_ADMISSION_RESPONSE_DEADLINE_MS - 5);

        const admissionRead = await timed(() => readHumanSubjectStates([activeUserId]));
        expect([...admissionRead.result.keys()]).toEqual([activeUserId]);
        expect(admissionRead.elapsedMs).toBeLessThan(ANSWERED_WELL_INSIDE_DEADLINE_MS);
      } finally {
        await mainPool.release();
      }
    });

    it('still gives a coalesced caller a real answer: active, deleted or unknown', async () => {
      const mainPool = await holdMainPoolFull();
      try {
        const answers = await timed(() =>
          Promise.all([
            isHumanSubjectActive(activeUserId),
            isHumanSubjectActive(deletedUserId),
            isHumanSubjectActive(randomUUID()),
          ]),
        );
        expect(answers.result).toEqual([true, false, false]);
        expect(answers.elapsedMs).toBeLessThan(ANSWERED_WELL_INSIDE_DEADLINE_MS);
      } finally {
        await mainPool.release();
      }
    });

    it('admits a signed credential and refuses a deleted account, as the GraphQL path does', async () => {
      const mainPool = await holdMainPoolFull();
      try {
        const signingKey = new TextEncoder().encode(process.env.NEXTAUTH_SECRET);
        const credentialFor = (userId: string) =>
          new SignJWT({})
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuer('boardsesh')
            .setAudience('boardsesh-mobile')
            .setSubject(userId)
            .setExpirationTime('5m')
            .sign(signingKey);

        await expect(validateToken(await credentialFor(activeUserId))).resolves.toMatchObject({ userId: activeUserId });
        await expect(validateToken(await credentialFor(deletedUserId))).resolves.toBeNull();
      } finally {
        await mainPool.release();
      }
    });
  });

  it('runs on two connections of its own, never more, however many reads arrive', async () => {
    expect(AUTH_ADMISSION_POOL_MAX_CONNECTIONS).toBe(2);
    const readers = Array.from({ length: 8 }, () => readHumanSubjectStates([activeUserId]));
    await Promise.all(readers);
    expect(getAdmissionPool().options.max).toBe(AUTH_ADMISSION_POOL_MAX_CONNECTIONS);
    const connections = await admissionConnectionCount();
    expect(connections).toBeGreaterThan(0);
    expect(connections).toBeLessThanOrEqual(AUTH_ADMISSION_POOL_MAX_CONNECTIONS);
  });

  it('hands its connections back to the server when closed', async () => {
    await readHumanSubjectStates([activeUserId]);
    expect(await admissionConnectionCount()).toBeGreaterThan(0);
    await closeAdmissionPool();
    await vi.waitFor(async () => expect(await admissionConnectionCount()).toBe(0), { timeout: 3000, interval: 25 });
  });

  it('keeps the deadline, and runs no more coalesced reads than it has connections', () => {
    expect(AUTH_ADMISSION_RESPONSE_DEADLINE_MS).toBe(1000);
    expect(MAX_UNSETTLED_AUTH_ADMISSION_READS).toBe(8);
    expect(MAX_CONCURRENT_COALESCED_ADMISSION_READS).toBe(AUTH_ADMISSION_POOL_MAX_CONNECTIONS);
  });

  it('gives up on an unanswered read a second after the statement timeout, and backs off replacing the pool', () => {
    expect(AUTH_ADMISSION_READ_WATCHDOG_MS).toBe(AUTH_ADMISSION_STATEMENT_TIMEOUT_MS + 1000);
    expect(AUTH_ADMISSION_RECYCLE_BACKOFF_MS).toEqual([5000, 10_000, 20_000]);
    expect(AUTH_ADMISSION_DEAD_SOCKET_AFTER_MS).toBe(
      AUTH_ADMISSION_CONNECT_TIMEOUT_S * 1000 + AUTH_ADMISSION_STATEMENT_TIMEOUT_MS + 2000,
    );
  });

  it('lets a dial outlive one read but end before the pool can be replaced again', () => {
    const connectTimeoutMs = AUTH_ADMISSION_CONNECT_TIMEOUT_S * 1000;
    expect(connectTimeoutMs).toBeGreaterThan(AUTH_ADMISSION_READ_WATCHDOG_MS);
    expect(connectTimeoutMs).toBeLessThan(AUTH_ADMISSION_RECYCLE_BACKOFF_MS[0]);
  });

  it('wins over the same startup parameters in DATABASE_URL, and leaves the others', async () => {
    vi.stubEnv(
      'DATABASE_URL',
      `${getWorkerDatabaseUrl()}?statement_timeout=45000&application_name=from-url&lock_timeout=12345`,
    );
    const [row] = await getAdmissionPool()<
      { statement_timeout: string; application_name: string; lock_timeout: string }[]
    >`
      SELECT current_setting('statement_timeout') AS statement_timeout,
             current_setting('application_name') AS application_name,
             current_setting('lock_timeout') AS lock_timeout`;
    expect(row).toEqual({
      statement_timeout: '1s',
      application_name: AUTH_ADMISSION_APPLICATION_NAME,
      lock_timeout: '12345ms',
    });
  });

  it('merges startup parameters for a dedicated pool over the shared ones', async () => {
    vi.stubEnv('DB_STATEMENT_TIMEOUT_MS', '45000');
    const dedicatedPool = createDedicatedPool(2, { connection: { application_name: 'merge-check' } });
    try {
      expect(dedicatedPool.options.connection.statement_timeout).toBe(45000);
      expect(dedicatedPool.options.connection.application_name).toBe('merge-check');
    } finally {
      await dedicatedPool.end();
    }
  });

  it('gives a connection four seconds to open, against the shared thirty', () => {
    expect(AUTH_ADMISSION_CONNECT_TIMEOUT_S).toBe(4);
    expect(getAdmissionPool().options.connect_timeout).toBe(AUTH_ADMISSION_CONNECT_TIMEOUT_S);
    expect(createPool().options.connect_timeout).toBe(30);
  });

  describe('when the path to Postgres stops answering', () => {
    let pauses: ReturnType<typeof watchForProcessPauses>;
    beforeEach(() => {
      pauses = watchForProcessPauses();
    });
    afterEach(() => {
      pauses.stop();
    });

    async function waitForAnAnswer(stopwatch: Stopwatch, maximumRunningMs: number) {
      for (;;) {
        const answered = await readHumanSubjectStates([activeUserId]).then(
          () => true,
          () => false,
        );
        if (answered) return;
        if (stopwatch.runningMs() > maximumRunningMs) throw new Error('Admission reads never recovered');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    it('replaces a pool whose connections stop answering, and reads come back', { timeout: 30000 }, async () => {
      const proxy = await startPostgresProxy();
      try {
        vi.stubEnv('DATABASE_URL', proxy.url);
        await Promise.all([readHumanSubjectStates([activeUserId]), readHumanSubjectStates([activeUserId])]);

        proxy.hangExistingConnections();
        const sinceHang = pauses.stopwatch();
        await waitForAnAnswer(sinceHang, 8000);

        expect(sinceHang.wallMs()).toBeGreaterThanOrEqual(AUTH_ADMISSION_READ_WATCHDOG_MS - 50);
        expect(sinceHang.runningMs()).toBeLessThan(AUTH_ADMISSION_READ_WATCHDOG_MS + 3000);
      } finally {
        await closeAdmissionPool();
        await proxy.close();
      }
    });

    it('recovers soon after a path that swallowed new connections heals', { timeout: 30000 }, async () => {
      const proxy = await startPostgresProxy();
      try {
        vi.stubEnv('DATABASE_URL', proxy.url);
        await readHumanSubjectStates([activeUserId]);

        proxy.severExistingConnections();
        proxy.setSwallowNewConnections(true);
        let sinceHeal: Stopwatch | undefined;
        const recovered = waitForAnAnswer(pauses.stopwatch(), 10000).then(() => sinceHeal?.runningMs());
        await new Promise((resolve) => setTimeout(resolve, 2500));
        proxy.setSwallowNewConnections(false);
        sinceHeal = pauses.stopwatch();

        // A dial swallowed just before the heal holds its slot until it times out.
        expect(await recovered).toBeLessThan(AUTH_ADMISSION_CONNECT_TIMEOUT_S * 1000 + 1500);
      } finally {
        await closeAdmissionPool();
        await proxy.close();
      }
    });

    it('reaches a primary that takes longer than the watchdog to open a connection', { timeout: 40000 }, async () => {
      const proxy = await startPostgresProxy();
      try {
        vi.stubEnv('DATABASE_URL', proxy.url);
        await readHumanSubjectStates([activeUserId]);

        proxy.severExistingConnections();
        proxy.setOpenDelayMs(AUTH_ADMISSION_READ_WATCHDOG_MS + 500);
        const sinceSlowed = pauses.stopwatch();
        // Answered while every new connection is still slow to open.
        await waitForAnAnswer(sinceSlowed, 12000);
        expect(sinceSlowed.runningMs()).toBeLessThan(10000);
      } finally {
        await closeAdmissionPool();
        await proxy.close();
      }
    });

    it('replaces a pool with one dead connection beside a healthy one', { timeout: 40000 }, async () => {
      const proxy = await startPostgresProxy();
      try {
        vi.stubEnv('DATABASE_URL', proxy.url);
        const slowRead = () =>
          readOnAdmissionConnection(
            () => {},
            (database) => database.execute(sql`select pg_sleep(0.4)`),
          );
        await Promise.all([slowRead(), slowRead()]);
        const poolWithDeadConnection = getAdmissionPool();

        proxy.hangFirstConnection();
        const sinceFrozen = pauses.stopwatch();
        // Traffic keeps the healthy connection answering, which is what used to hide the dead one.
        while (getAdmissionPool() === poolWithDeadConnection && sinceFrozen.runningMs() < 12000) {
          await Promise.allSettled([slowRead(), slowRead()]);
        }

        expect(getAdmissionPool()).not.toBe(poolWithDeadConnection);
        expect(sinceFrozen.wallMs()).toBeGreaterThanOrEqual(AUTH_ADMISSION_DEAD_SOCKET_AFTER_MS - 100);
        expect(sinceFrozen.runningMs()).toBeLessThan(AUTH_ADMISSION_DEAD_SOCKET_AFTER_MS + 3000);
        await Promise.all([slowRead(), slowRead()]);
      } finally {
        await closeAdmissionPool();
        await proxy.close();
      }
    });

    it('keeps backing off while each new connection answers briefly and then hangs', { timeout: 40000 }, async () => {
      const proxy = await startPostgresProxy();
      const backoffSteps: number[] = [];
      vi.spyOn(logger, 'warn').mockImplementation((_message: unknown, fields?: unknown) => {
        const step = (fields as { replacementsInSequence?: unknown } | undefined)?.replacementsInSequence;
        if (typeof step === 'number') backoffSteps.push(step);
        return logger;
      });
      try {
        vi.stubEnv('DATABASE_URL', proxy.url);
        await readHumanSubjectStates([activeUserId]);

        proxy.setFreezeNewConnections(true);
        proxy.hangExistingConnections();
        const sinceFault = pauses.stopwatch();
        while (sinceFault.runningMs() < 12000) {
          await readHumanSubjectStates([activeUserId]).catch(() => undefined);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        // Answers on each fresh pool used to restart the schedule, so every replacement was the first.
        expect(Math.max(...backoffSteps)).toBeGreaterThanOrEqual(2);
      } finally {
        vi.mocked(logger.warn).mockRestore();
        await closeAdmissionPool();
        await proxy.close();
      }
    });

    it('closes within its bound even with a read that never returns', { timeout: 30000 }, async () => {
      const proxy = await startPostgresProxy();
      try {
        vi.stubEnv('DATABASE_URL', proxy.url);
        await readHumanSubjectStates([activeUserId]);

        proxy.hangExistingConnections();
        const hungRead = readOnAdmissionConnection(
          () => {},
          (database) => database.execute(sql`select 1`),
        ).catch(() => undefined);
        await nextEventLoopTurn();

        const closing = pauses.stopwatch();
        await closeAdmissionPool();
        expect(closing.runningMs()).toBeLessThan(AUTH_ADMISSION_READ_WATCHDOG_MS + 1000);
        await hungRead;
      } finally {
        await proxy.close();
      }
    });
  });

  it('retries a refused connection through the shared connect retry', async () => {
    const closedPort = await unusedLocalPort();
    const retries: DbConnectRetryEvent[] = [];
    setDbConnectObserver((event) => retries.push(event));
    try {
      vi.stubEnv('DATABASE_URL', `postgresql://postgres:postgres@127.0.0.1:${closedPort}/admission`);
      await expect(
        readOnAdmissionConnection(
          () => {},
          (database) => database.execute(sql`select 1`),
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(retries.map((event) => event.code)).toContain('ECONNREFUSED');
    } finally {
      setDbConnectObserver(null);
    }
  });

  it('carries the tight statement timeout on the connection itself', async () => {
    expect(AUTH_ADMISSION_STATEMENT_TIMEOUT_MS).toBe(AUTH_ADMISSION_RESPONSE_DEADLINE_MS);
    const [row] = await getAdmissionPool()<{ statement_timeout: string }[]>`SHOW statement_timeout`;
    expect(row.statement_timeout).toBe('1s');
  });

  it('overrides a longer DB_STATEMENT_TIMEOUT_MS for this pool only', async () => {
    vi.stubEnv('DB_STATEMENT_TIMEOUT_MS', '45000');
    const [row] = await getAdmissionPool()<{ statement_timeout: string }[]>`SHOW statement_timeout`;
    expect(row.statement_timeout).toBe('1s');
    expect(createPool().options.connection.statement_timeout).toBeUndefined();
  });

  it('has the server cancel a blocked read at the timeout and gives back its connection', async () => {
    const lockHolder = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
    const lockGranted = deferred();
    const lockReleased = deferred();
    const holdingLock = lockHolder.begin(async (transaction) => {
      await transaction`LOCK TABLE users IN ACCESS EXCLUSIVE MODE`;
      lockGranted.resolve();
      await lockReleased.promise;
    });
    try {
      await lockGranted.promise;
      await expect(readHumanSubjectStates([activeUserId])).rejects.toBeInstanceOf(AuthAdmissionUnavailableError);
      // The server gave up while the lock is still held. Without the startup
      // parameter this statement sits on the connection until the lock clears.
      await vi.waitFor(async () => expect(await runningAdmissionStatements()).toBe(0), {
        timeout: AUTH_ADMISSION_RESPONSE_DEADLINE_MS * 2,
        interval: 50,
      });
    } finally {
      lockReleased.resolve();
      await holdingLock;
      await lockHolder.end();
    }
    await expect(readHumanSubjectStates([activeUserId])).resolves.toEqual(
      new Map([[activeUserId, { generation: 0, nativeGeneration: 0, deniedSessionKeys: new Set() }]]),
    );
  });

  it('opens on the primary, never the replica, with the same TLS as the main pool', async () => {
    vi.stubEnv('READ_REPLICA_URL', 'postgres://reader:secret@replica.invalid:6543/replica');
    vi.stubEnv('DATABASE_URL', 'postgres://writer:secret@primary.example.com:5432/railway');
    expect(getAdmissionPool().options.host).toEqual(['primary.example.com']);
    expect(getAdmissionPool().options.ssl).toBe('require');

    await closeAdmissionPool();
    vi.stubEnv('DATABASE_URL', 'postgres://writer:secret@primary.example.com:5432/railway?sslmode=verify-full');
    expect(getAdmissionPool().options.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('creates nothing on import, one pool on first use, and a fresh one after closing', async () => {
    const {
      createDedicatedPool: actualCreateDedicatedPool,
      withConnectRetry: actualWithConnectRetry,
      ...actualClient
    } = await vi.importActual<typeof import('@boardsesh/db/client')>('@boardsesh/db/client');
    const createDedicatedPool = vi.fn(actualCreateDedicatedPool);
    const withConnectRetry = vi.fn(actualWithConnectRetry);
    vi.resetModules();
    vi.doMock('@boardsesh/db/client', () => ({ ...actualClient, createDedicatedPool, withConnectRetry }));
    try {
      const isolated = await import('../admission-pool');
      expect(createDedicatedPool).not.toHaveBeenCalled();

      const readOnce = () =>
        isolated.readOnAdmissionConnection(
          () => {},
          (database) => database.execute(sql`select 1`),
        );
      await readOnce();
      await readOnce();
      expect(createDedicatedPool).toHaveBeenCalledTimes(1);
      expect(createDedicatedPool).toHaveBeenCalledWith(
        AUTH_ADMISSION_POOL_MAX_CONNECTIONS,
        expect.objectContaining({ connect_timeout: AUTH_ADMISSION_CONNECT_TIMEOUT_S }),
      );
      // A timed-out dial is already past the caller's deadline, so it is not retried.
      expect(AUTH_ADMISSION_CONNECT_RETRY_BUDGET_MS).toBe(AUTH_ADMISSION_RESPONSE_DEADLINE_MS);
      expect(withConnectRetry).toHaveBeenCalledWith(createDedicatedPool.mock.results[0].value, {
        budgetMs: AUTH_ADMISSION_CONNECT_RETRY_BUDGET_MS,
      });

      await isolated.closeAdmissionPool();
      await readOnce();
      expect(createDedicatedPool).toHaveBeenCalledTimes(2);
      await isolated.closeAdmissionPool();
    } finally {
      vi.doUnmock('@boardsesh/db/client');
      vi.resetModules();
    }
  });

  describe('readOnAdmissionConnection', () => {
    it('never runs more reads than connections, and starts the rest in arrival order', async () => {
      const finishRead = Array.from({ length: 4 }, () => deferred());
      const started: number[] = [];
      const reads = finishRead.map(({ promise }, index) =>
        readOnAdmissionConnection(
          () => started.push(index),
          () => promise,
        ),
      );
      await nextEventLoopTurn();
      expect(started).toEqual([0, 1]);

      finishRead[1].resolve();
      await nextEventLoopTurn();
      expect(started).toEqual([0, 1, 2]);

      finishRead[0].resolve();
      await nextEventLoopTurn();
      expect(started).toEqual([0, 1, 2, 3]);

      finishRead[2].resolve();
      finishRead[3].resolve();
      await Promise.all(reads);
    });

    it('gives back the connection when a read fails, so the next one still runs', async () => {
      const failure = new Error('read failed');
      const failed = deferred();
      const blocked = deferred();
      const started: string[] = [];
      const reads = [
        readOnAdmissionConnection(
          () => started.push('failed'),
          () => failed.promise,
        ),
        readOnAdmissionConnection(
          () => started.push('blocked'),
          () => blocked.promise,
        ),
        readOnAdmissionConnection(
          () => started.push('next'),
          async () => undefined,
        ),
      ];
      const failedRead = expect(reads[0]).rejects.toBe(failure);
      await nextEventLoopTurn();
      expect(started).toEqual(['failed', 'blocked']);
      failed.reject(failure);
      await nextEventLoopTurn();
      expect(started).toEqual(['failed', 'blocked', 'next']);
      await failedRead;
      blocked.resolve();
      await Promise.all(reads.slice(1));
    });
  });
});
