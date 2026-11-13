import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import {
  AUTH_PROTOCOL_VERSION,
  LOCATION_SYNC_COMMAND_PATH,
  type LocationSyncCommand,
  type LocationSyncWireRecord,
} from '@boardsesh/auth-protocol';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import type { DbInstance } from '@boardsesh/db/client';
import { initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';
import { claimBackgroundJobRun } from '@boardsesh/db/queries';
import { lockSharedFixedSystemOwnerTransaction } from '@boardsesh/db/fixed-system-owner-order';
import { gyms, userBoards, locationSyncGymSources, backgroundJobRuns } from '@boardsesh/db/schema';
import {
  users,
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  authSubjectCutoffs,
  accounts,
  authAccount,
  authSession,
  userCredentials,
  sessions,
  mobileRefreshTokens,
  verificationTokens,
  userProfiles,
} from '@boardsesh/db/schema/auth';
import {
  SYSTEM_USER_ID,
  boardUuidForSource,
  upsertPublicBoardLocationsInBatches,
  type PublicBoardLocationInput,
} from '@boardsesh/location-sync';
import { handleCurrentStoreLocationSync } from '../../handlers/current-store-location-sync';
import {
  enqueueBackgroundJob,
  executeBackgroundJob,
  handlerForRole,
  type BackgroundJobPayload,
} from '../../workers/jobs';
import { createLocationBatchWriter } from '../current-store/location-sync-client';
import { executeLocationSyncCommand } from '../current-store/location-sync';
import { prepareProjectionUnderUsersTableLock } from '../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../current-store/foundation-context';
import { readIdentityAuthority } from '../authority/router';
import { registerWebPassword } from '../current-store/web-password';
import { deleteExpiredCommandClaims } from '../current-store/command-context';
import { buildMoonBoardLocationRecords } from '@boardsesh/moonboard-sync/sync';

function ownedUrl(): URL {
  const address = new URL(process.env.LOCATION_SYNC_PROOF_DATABASE_URL ?? '');
  const localOwned = address.port === '55479' && /^epic6975_location_[0-9]{8}$/.test(address.pathname.slice(1));
  const ciOwned =
    process.env.CI === 'true' &&
    process.env.GITHUB_ACTIONS === 'true' &&
    address.port === '5432' &&
    address.pathname === '/epic6975_location_ci';
  if (
    !['postgres:', 'postgresql:'].includes(address.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) ||
    !(localOwned || ciOwned) ||
    address.search ||
    address.hash
  )
    throw new Error('Location proof requires its explicit owned local PostGIS database');
  return address;
}
let ownerPool: ReturnType<typeof postgres>;
let backendPool: ReturnType<typeof postgres>;
let database: DbInstance;
let backendDatabase: DbInstance;
let boss: PgBoss;
let server: Server;
let origin = '';
let dropSuccessReply = false;
let requestCount = 0;
const backendRole = `ba04_location_${randomUUID().replaceAll('-', '')}`;
const secret = randomBytes(32).toString('hex');
const originalDeletedEmailKey = process.env.CURRENT_STORE_DELETED_EMAIL_KEY;
const environment: Record<string, string | undefined> = {
  NODE_ENV: 'test',
  CURRENT_STORE_LOCATION_SYNC_MODE: 'backend-staging',
  CURRENT_STORE_LOCATION_SYNC_RPC_SECRET: secret,
  CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
  AUTH_CUTOFF_ENFORCEMENT: 'enforce',
  CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE: 'cooperative-staging',
  CURRENT_STORE_DELETED_EMAIL_KEY: randomBytes(32).toString('hex'),
};
let qualification: { expectedProjectionId: string; expectedNormalizerVersion: string };
function record(index = 0, overrides: Partial<LocationSyncWireRecord> = {}): LocationSyncWireRecord {
  return {
    boardType: 'moonboard',
    layoutId: 2,
    sizeId: 1,
    setIds: '1',
    angle: 40,
    isAngleAdjustable: false,
    sourceKey: `moonboard:proof-${index}:board`,
    gymSourceKey: `moonboard:proof-${index}`,
    name: `Proof board ${index}`,
    slugBase: `proof-board-${index}`,
    locationName: null,
    latitude: 45 + index / 100,
    longitude: -1,
    gymName: `Proof gym ${index}`,
    gymAddress: null,
    ...overrides,
  };
}
async function queuedJob(family: string, payload: Record<string, unknown> = {}) {
  const enqueued = await enqueueBackgroundJob(database, boss, {
    family,
    payload,
    role: 'routine-provider',
    singletonKey: randomUUID(),
  });
  const [job] = await boss.fetch<BackgroundJobPayload>(BACKGROUND_JOB_QUEUES['routine-provider'], {
    includeMetadata: true,
    batchSize: 1,
  });
  if (!job || job.id !== enqueued.runId) throw new Error('Owned location fixture expected its real job');
  return job;
}
async function command(
  records = [record()],
  family = 'moonboard-locations-sync',
  payload: Record<string, unknown> = {},
): Promise<LocationSyncCommand> {
  const job = await queuedJob(family, payload);
  const attemptToken = await claimBackgroundJobRun(database, job.id, job.name, job.retryCount);
  if (!attemptToken) throw new Error('Owned location attempt was not claimed');
  return {
    protocolVersion: 1,
    operation: 'apply',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { runId: job.id, attemptToken, records },
  };
}
async function post(input: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}${LOCATION_SYNC_COMMAND_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, ...headers },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(35_000),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}
async function state() {
  return {
    users: await database.select().from(users),
    reservations: await database.select().from(authEmailReservations),
    members: await database.select().from(authEmailReservationMembers),
    nonces: await database.select().from(verificationTokens),
    gyms: await database.select().from(gyms),
    boards: await database.select().from(userBoards),
    aliases: await database.select().from(locationSyncGymSources),
    credentials: await database.select().from(userCredentials),
    accounts: await database.select().from(accounts),
    canonicalAccounts: await database.select().from(authAccount),
    canonicalSessions: await database.select().from(authSession),
    sessions: await database.select().from(sessions),
    refresh: await database.select().from(mobileRefreshTokens),
    profiles: await database.select().from(userProfiles),
  };
}
async function selectAuthority(authority: 'current-store' | 'better-auth') {
  await database
    .update(authEmailProjection)
    .set({ writerAuthority: authority, writerEpoch: authority === 'better-auth' ? 2 : 1 });
}
function deferred() {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}

// A dedicated disposable cluster is mandatory: reset/roles/triggers below are owned by this proof only.
describe('selected location owner plus complete-gym data under actual HTTP/PostGIS/job fences', () => {
  beforeAll(async () => {
    const address = ownedUrl();
    process.env.CURRENT_STORE_DELETED_EMAIL_KEY = environment.CURRENT_STORE_DELETED_EMAIL_KEY;
    ownerPool = postgres(address.href, { max: 5, onnotice: () => {}, connect_timeout: 3 });
    database = drizzle(ownerPool) as unknown as DbInstance;
    const [extensions] = await ownerPool`SELECT postgis_version() AS version`;
    expect(extensions.version).toBeTruthy();
    const [migrations] = await ownerPool`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
    expect(migrations.count).toBeGreaterThan(200);
    const queueSetupPool = postgres(address.href, { max: 1, onnotice: () => {} });
    try {
      await initializeJobQueueSchema(drizzle(queueSetupPool));
    } finally {
      await queueSetupPool.end({ timeout: 2 });
    }
    const password = randomBytes(32).toString('hex');
    await database.execute(
      sql`CREATE ROLE ${sql.identifier(backendRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${password}'`)}`,
    );
    await database.execute(sql`GRANT USAGE ON SCHEMA public, pgboss TO ${sql.identifier(backendRole)}`);
    await database.execute(
      sql`GRANT SELECT, INSERT, UPDATE ON TABLE ${users}, ${authEmailReservations}, ${gyms}, ${userBoards}, ${locationSyncGymSources} TO ${sql.identifier(backendRole)}`,
    );
    await database.execute(
      sql`GRANT SELECT, INSERT ON TABLE ${authEmailReservationMembers}, ${verificationTokens} TO ${sql.identifier(backendRole)}`,
    );
    await database.execute(
      sql`GRANT SELECT, UPDATE ON TABLE ${authEmailProjection}, ${authSubjectCutoffs}, ${backgroundJobRuns}, pgboss.job TO ${sql.identifier(backendRole)}`,
    );
    await database.execute(
      sql`GRANT SELECT ON TABLE ${accounts}, ${authAccount}, ${authSession}, ${userCredentials}, ${sessions}, ${mobileRefreshTokens}, public.gym_claims, public.gym_members, public.gym_follows, public.comments TO ${sql.identifier(backendRole)}`,
    );
    await database.execute(
      sql`GRANT UPDATE (updated_at) ON TABLE ${authAccount}, ${userCredentials} TO ${sql.identifier(backendRole)}`,
    );
    await database.execute(
      sql`GRANT UPDATE (${sql.identifier(accounts.userId.name)}) ON TABLE ${accounts} TO ${sql.identifier(backendRole)}`,
    );
    await database.execute(
      sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${sql.identifier(backendRole)}`,
    );
    address.username = backendRole;
    address.password = password;
    backendPool = postgres(address.href, { max: 3, onnotice: () => {}, connect_timeout: 3 });
    backendDatabase = drizzle(backendPool) as unknown as DbInstance;
    boss = new PgBoss({ connectionString: ownedUrl().href, max: 1, migrate: false, supervise: false, schedule: false });
    boss.on('error', () => {});
    await boss.start();
    server = createServer((request, response) => {
      requestCount += 1;
      const originalEnd = response.end.bind(response);
      response.end = ((...arguments_: unknown[]) => {
        if (dropSuccessReply && response.statusCode === 200) {
          response.destroy();
          return response;
        }
        return Reflect.apply(originalEnd, response, arguments_);
      }) as typeof response.end;
      void handleCurrentStoreLocationSync(request, response, backendDatabase, environment).catch(() =>
        response.destroy(),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const bound = server.address();
    if (!bound || typeof bound === 'string') throw new Error('Owned HTTP did not bind');
    origin = `http://127.0.0.1:${bound.port}`;
    environment.CURRENT_STORE_LOCATION_SYNC_ORIGIN = origin;
  });
  beforeEach(async () => {
    ownedUrl();
    dropSuccessReply = false;
    requestCount = 0;
    await boss.deleteAllJobs(BACKGROUND_JOB_QUEUES['routine-provider']);
    // Full-schema logbook capture deliberately forbids TRUNCATE. Keep every
    // production trigger enabled while clearing only this disposable proof.
    await database.delete(userBoards);
    await database.delete(locationSyncGymSources);
    await database.delete(gyms);
    await database.delete(authEmailReservationMembers);
    await database.delete(authEmailReservations);
    await database.delete(authSubjectCutoffs);
    await database.delete(users);
    await database.delete(backgroundJobRuns);
    await database.delete(verificationTokens);
    await database.delete(authEmailProjection);
    const projectionId = randomUUID();
    await database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
    qualification = { expectedProjectionId: projectionId, expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION };
    environment.CURRENT_STORE_AUTH_PROJECTION_ID = projectionId;
    environment.CURRENT_STORE_LOCATION_SYNC_MODE = 'backend-staging';
    environment.CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE = 'cooperative-staging';
    await database.execute(sql`DROP TRIGGER IF EXISTS location_proof_reject ON user_boards`);
  });
  afterAll(async () => {
    if (originalDeletedEmailKey === undefined) delete process.env.CURRENT_STORE_DELETED_EMAIL_KEY;
    else process.env.CURRENT_STORE_DELETED_EMAIL_KEY = originalDeletedEmailKey;
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    await boss?.stop();
    await backendPool?.end({ timeout: 2 });
    if (ownerPool) {
      const [role] = await ownerPool`SELECT 1 FROM pg_roles WHERE rolname = ${backendRole}`;
      if (role) {
        await ownerPool.unsafe(`DROP OWNED BY ${backendRole}`);
        await ownerPool.unsafe(`DROP ROLE ${backendRole}`);
      }
      await ownerPool.end({ timeout: 2 });
    }
  });

  it.each(['current-store', 'better-auth'] as const)(
    'commits reserved owner, PostGIS triggers and complete data with %s selected and mirror off',
    async (authority) => {
      await selectAuthority(authority);
      const input = await command();
      expect((await post(input)).status).toBe(200);
      const snapshot = await state();
      expect(snapshot.users).toMatchObject([
        { id: SYSTEM_USER_ID, email: 'system@boardsesh.com', emailVerified: null },
      ]);
      expect(snapshot.reservations).toMatchObject([{ ownerUserId: SYSTEM_USER_ID, state: 'owned' }]);
      expect(snapshot.boards).toMatchObject([
        { ownerId: SYSTEM_USER_ID, uuid: boardUuidForSource(input.payload.records[0].sourceKey) },
      ]);
      expect(snapshot.gyms).toHaveLength(1);
      expect(snapshot.aliases).toHaveLength(1);
      expect(snapshot.nonces).toHaveLength(1);
      const [geography] = await ownerPool`SELECT ST_AsText(location::geometry) AS location FROM gyms`;
      expect(geography.location).toBe('POINT(-1 45)');
      for (const key of [
        'credentials',
        'accounts',
        'canonicalAccounts',
        'canonicalSessions',
        'sessions',
        'refresh',
        'profiles',
      ] as const)
        expect(snapshot[key]).toEqual([]);
    },
  );

  it.each(['current-store', 'better-auth'] as const)(
    'rolls the first owner, nonce, reservation and content back after a real data failure (%s)',
    async (authority) => {
      await selectAuthority(authority);
      await ownerPool.unsafe(
        `CREATE OR REPLACE FUNCTION location_proof_reject_board() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned location failure'; END $$`,
      );
      await ownerPool.unsafe(
        `CREATE TRIGGER location_proof_reject BEFORE INSERT ON user_boards FOR EACH ROW EXECUTE FUNCTION location_proof_reject_board()`,
      );
      const before = await state();
      expect((await post(await command())).status).toBe(503);
      expect(await state()).toEqual(before);
    },
  );

  it('rejects stale job attempts, wrong provider provenance, replay and stale projection without mutation', async () => {
    const input = await command();
    const before = await state();
    expect((await post({ ...input, payload: { ...input.payload, attemptToken: randomUUID() } })).status).toBe(409);
    expect(await state()).toEqual(before);
    expect(
      (await post({ ...input, payload: { ...input.payload, records: [record(0, { boardType: 'tension' })] } })).status,
    ).toBe(503);
    expect(await state()).toEqual(before);
    environment.CURRENT_STORE_AUTH_PROJECTION_ID = randomUUID();
    expect((await post(input)).status).toBe(503);
    expect(await state()).toEqual(before);
    environment.CURRENT_STORE_AUTH_PROJECTION_ID = qualification.expectedProjectionId;
    expect((await post(input)).status).toBe(200);
    const committed = await state();
    expect((await post(input)).status).toBe(409);
    expect(await state()).toEqual(committed);
  });

  it.each(['tension', 'decoy', 'touchstone', 'grasshopper', 'soill'])(
    'derives %s permissions from the locked Aurora job',
    async (boardType) => {
      const input = await command(
        [
          record(0, {
            boardType: boardType as LocationSyncWireRecord['boardType'],
            sourceKey: `${boardType}:board`,
            gymSourceKey: `${boardType}:gym`,
          }),
        ],
        'aurora-shared-sync',
        { board: boardType },
      );
      expect((await post(input)).status).toBe(200);
    },
  );

  it('preserves invalid-coordinate skips through the actual private client codec', async () => {
    const input = await command();
    const writer = createLocationBatchWriter({ ...input.payload, environment, signal: new AbortController().signal });
    if (!writer) throw new Error('Expected staged writer');
    const invalid = {
      ...record(),
      latitude: Number.NaN,
      longitude: Number.POSITIVE_INFINITY,
    } as PublicBoardLocationInput;
    const summary = await writer([invalid]);
    expect(summary).toMatchObject({ boardsSeen: 1, boardsSkipped: 1, boardsUpserted: 0 });
    expect((await state()).users).toHaveLength(1);
    expect((await state()).boards).toHaveLength(0);
  });

  it('keeps the first 25 complete gyms committed when the next delegated batch fails', async () => {
    const input = await command();
    const writer = createLocationBatchWriter({ ...input.payload, environment, signal: new AbortController().signal });
    if (!writer) throw new Error('Expected staged writer');
    await ownerPool.unsafe(
      `CREATE OR REPLACE FUNCTION location_proof_reject_board() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = 'Proof board 25' THEN RAISE EXCEPTION 'owned second-batch failure'; END IF; RETURN NEW; END $$`,
    );
    await ownerPool.unsafe(
      `CREATE TRIGGER location_proof_reject BEFORE INSERT ON user_boards FOR EACH ROW EXECUTE FUNCTION location_proof_reject_board()`,
    );
    const records = Array.from({ length: 26 }, (_, index) => record(index) as PublicBoardLocationInput);
    await expect(
      upsertPublicBoardLocationsInBatches(
        async () => {
          throw new Error('Remote call entered worker transaction');
        },
        records,
        { batchWriter: writer },
      ),
    ).rejects.toThrow();
    expect((await state()).boards).toHaveLength(25);
    expect((await state()).nonces).toHaveLength(1);
    expect((await state()).users).toHaveLength(1);
  });

  it('rejects oversized complete gyms and browser/wrong-secret calls before owner SQL', async () => {
    const input = await command();
    const before = await state();
    expect((await post(input, { Origin: origin })).status).toBe(401);
    expect((await post(input, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect(
      (await post({ ...input, payload: { ...input.payload, records: Array.from({ length: 1025 }, () => record()) } }))
        .status,
    ).toBe(400);
    expect(await state()).toEqual(before);
  });

  it('rejects an oversized complete-gym wire command before any HTTP or SQL fallback', async () => {
    const input = await command();
    const writer = createLocationBatchWriter({ ...input.payload, environment, signal: new AbortController().signal });
    if (!writer) throw new Error('Expected staged writer');
    const before = await state();
    await expect(
      writer(Array.from({ length: 1024 }, () => ({ ...record(), name: 'n'.repeat(4096) }) as PublicBoardLocationInput)),
    ).rejects.toThrow();
    expect(requestCount).toBe(0);
    expect(await state()).toEqual(before);
  });

  it('reclaims expired location replay claims through the existing bounded command cleanup', async () => {
    expect((await post(await command())).status).toBe(200);
    await database.update(verificationTokens).set({ expires: new Date(Date.now() - 1_000) });
    expect(await deleteExpiredCommandClaims(database, 1)).toBe(1);
    expect((await state()).nonces).toHaveLength(0);
    expect((await state()).boards).toHaveLength(1);
  });

  it('rejects a cooperating content holder immediately, then succeeds after it releases', async () => {
    const input = await command();
    const held = deferred();
    const release = deferred();
    const blocker = database.transaction(async (transaction) => {
      await lockSharedFixedSystemOwnerTransaction(transaction);
      held.release();
      await release.pending;
    });
    await held.pending;
    try {
      expect((await post(input)).status).toBe(503);
      expect((await state()).users).toHaveLength(0);
    } finally {
      release.release();
      await blocker;
    }
    expect((await post(input)).status).toBe(200);
  });

  it('bounds an existing owner-row wait and permits retry after the content transaction releases', async () => {
    expect((await post(await command())).status).toBe(200);
    const input = await command([record(1)]);
    const held = deferred();
    const release = deferred();
    const blocker = database.transaction(async (transaction) => {
      await transaction.select().from(users).where(eq(users.id, SYSTEM_USER_ID)).for('key share');
      held.release();
      await release.pending;
    });
    await held.pending;
    const before = await state();
    try {
      expect((await post(input)).status).toBe(503);
      expect(await state()).toEqual(before);
    } finally {
      release.release();
      await blocker;
    }
    expect((await post(input)).status).toBe(200);
  });

  it.each(['current-store', 'better-auth'] as const)(
    'revalidates %s receipt after real data SQL and rolls an unfenced epoch change back',
    async (authority) => {
      await selectAuthority(authority);
      const input = await command();
      await ownerPool.unsafe(
        `CREATE OR REPLACE FUNCTION location_proof_reject_board() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(4); RETURN NEW; END $$`,
      );
      await ownerPool.unsafe(
        `CREATE TRIGGER location_proof_reject BEFORE INSERT ON user_boards FOR EACH ROW EXECUTE FUNCTION location_proof_reject_board()`,
      );
      let settled = false;
      const pending = post(input).then((reply) => {
        settled = true;
        return reply;
      });
      const deadline = Date.now() + 3_000;
      while (true) {
        const [waiting] =
          await ownerPool`SELECT 1 FROM pg_stat_activity WHERE usename = ${backendRole} AND wait_event = 'PgSleep' AND query LIKE '%user_boards%'`;
        if (waiting) break;
        if (Date.now() >= deadline) throw new Error('Owned location statement sleep was not observed');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Positive unrelated registration takes the same shared gate and its own
      // user/reservation locks while the location statement is actually sleeping.
      const startedAt = performance.now();
      expect(
        await registerWebPassword(
          database,
          { ...qualification, expectedWriterEpoch: 1, emailVerificationEnabled: false },
          {
            protocolVersion: AUTH_PROTOCOL_VERSION,
            operation: 'register',
            requestId: randomUUID(),
            issuedAt: Date.now(),
            payload: {
              email: 'unrelated@example.invalid',
              password: 'owned-unrelated-password',
              name: 'Unrelated climber',
            },
          },
        ),
      ).toMatchObject({ outcome: 'created' });
      expect(performance.now() - startedAt).toBeLessThan(3_000);
      expect(await readIdentityAuthority(database, qualification)).toMatchObject({ authority });
      const before = await state();
      expect(settled).toBe(false);
      const [stillSleeping] =
        await ownerPool`SELECT 1 FROM pg_stat_activity WHERE usename = ${backendRole} AND wait_event = 'PgSleep'`;
      expect(stillSleeping).toBeTruthy();
      // Deliberately bypass the cooperative gate while data SQL remains in flight.
      await database.update(authEmailProjection).set({ writerEpoch: authority === 'better-auth' ? 3 : 2 });
      expect((await pending).status).toBe(503);
      expect(await state()).toEqual(before);
    },
  );

  it('expires the real queue lease during in-flight data SQL and rolls owner/data/nonce back', async () => {
    const input = await command();
    const before = await state();
    await ownerPool`UPDATE pgboss.job SET started_on = clock_timestamp(), expire_seconds = 1 WHERE id = ${input.payload.runId}`;
    await ownerPool.unsafe(
      `CREATE OR REPLACE FUNCTION location_proof_reject_board() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.2); RETURN NEW; END $$`,
    );
    await ownerPool.unsafe(
      `CREATE TRIGGER location_proof_reject BEFORE INSERT ON user_boards FOR EACH ROW EXECUTE FUNCTION location_proof_reject_board()`,
    );
    expect((await post(input)).status).toBe(409);
    expect(await state()).toEqual(before);
  });

  it('does not retry or fall back after a real committed-success reply is lost', async () => {
    const input = await command();
    const writer = createLocationBatchWriter({ ...input.payload, environment, signal: new AbortController().signal });
    if (!writer) throw new Error('Expected staged writer');
    let workerTransactions = 0;
    dropSuccessReply = true;
    await expect(
      upsertPublicBoardLocationsInBatches(
        async () => {
          workerTransactions += 1;
          throw new Error('Remote request entered worker SQL');
        },
        [record() as PublicBoardLocationInput],
        { batchWriter: writer },
      ),
    ).rejects.toThrow();
    expect(requestCount).toBe(1);
    expect(workerTransactions).toBe(0);
    expect((await state()).users).toHaveLength(1);
    expect((await state()).boards).toHaveLength(1);
    expect((await state()).nonces).toHaveLength(1);
  });

  it('accepts the real 350-record MoonBoard catalog for 25 complete gyms within its command budget', async () => {
    const input = await command();
    const writer = createLocationBatchWriter({ ...input.payload, environment, signal: new AbortController().signal });
    if (!writer) throw new Error('Expected staged writer');
    const records = buildMoonBoardLocationRecords(
      Array.from({ length: 25 }, (_, index) => ({
        Name: `Real catalog gym ${index}`,
        Latitude: 45 + index / 100,
        Longitude: -1,
      })),
    );
    expect(records).toHaveLength(350);
    const startedAt = performance.now();
    expect(await writer(records)).toMatchObject({
      boardsSeen: 350,
      boardsUpserted: 350,
      gymsSeen: 25,
      gymsUpserted: 25,
    });
    expect(performance.now() - startedAt).toBeLessThan(25_000);
    expect(requestCount).toBe(1);
    expect((await state()).boards).toHaveLength(350);
  });

  it('preserves curated aliases and frozen metadata through mounted compound writes', async () => {
    expect((await post(await command())).status).toBe(200);
    const [gym] = await database.select().from(gyms);
    await database
      .insert(users)
      .values({ id: 'owned-curator', name: 'Owned curator', email: 'owned-curator@example.invalid' });
    await database.transaction(async (transaction) => {
      await lockSharedFixedSystemOwnerTransaction(transaction);
      await transaction
        .update(gyms)
        .set({ ownerId: 'owned-curator', name: 'Curator name', address: 'Curator address', syncFrozenAt: new Date() })
        .where(eq(gyms.id, gym.id));
      await transaction.update(userBoards).set({ syncFrozenAt: new Date() });
    });
    const before = await state();
    expect(
      (await post(await command([record(0, { gymName: 'Provider overwrite', name: 'Provider board overwrite' })])))
        .status,
    ).toBe(200);
    const after = await state();
    expect(after.gyms).toEqual(before.gyms);
    expect(after.boards).toEqual(before.boards);
    expect(after.aliases).toEqual(before.aliases);
  });

  it('rolls back an already expired compound deadline before owner creation', async () => {
    const input = await command();
    const before = await state();
    await expect(
      executeLocationSyncCommand(backendDatabase, qualification, input, performance.now() - 1),
    ).rejects.toMatchObject({ code: 'request_expired' });
    expect(await state()).toEqual(before);
  });

  it.each([
    ['aurora-shared-sync', { board: 'tension' }],
    ['moonboard-locations-sync', {}],
  ] as const)(
    'keeps actual dispatcher %s credential-absent no-ops without private RPC configuration',
    async (family, payload) => {
      const keys = [
        'CURRENT_STORE_LOCATION_SYNC_MODE',
        'CURRENT_STORE_LOCATION_SYNC_ORIGIN',
        'CURRENT_STORE_LOCATION_SYNC_RPC_SECRET',
        'CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE',
        'MOONBOARD_USERNAME',
        'MOONBOARD_PASSWORD',
      ];
      const prior = new Map(keys.map((key) => [key, process.env[key]]));
      try {
        for (const key of keys) delete process.env[key];
        process.env.CURRENT_STORE_LOCATION_SYNC_MODE = 'backend-staging';
        const job = await queuedJob(family, payload);
        expect(
          await executeBackgroundJob(
            database,
            boss,
            job,
            handlerForRole('routine-provider'),
            new AbortController().signal,
          ),
        ).toBe('succeeded');
        const [run] = await database.select().from(backgroundJobRuns).where(eq(backgroundJobRuns.id, job.id));
        expect(run.status).toBe('succeeded');
        expect((await state()).users).toEqual([]);
        expect((await state()).nonces).toEqual([]);
        expect((await state()).boards).toEqual([]);
      } finally {
        for (const [key, contents] of prior) {
          if (contents === undefined) delete process.env[key];
          else process.env[key] = contents;
        }
      }
    },
  );

  it('refuses compound staging without the cooperative content prerequisite before writes', async () => {
    const input = await command();
    const before = await state();
    delete environment.CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE;
    expect((await post(input)).status).toBe(503);
    expect(await state()).toEqual(before);
  });

  it('leaves the private endpoint disabled by default without consulting authority', async () => {
    delete environment.CURRENT_STORE_LOCATION_SYNC_MODE;
    expect((await post({})).status).toBe(404);
  });
});
