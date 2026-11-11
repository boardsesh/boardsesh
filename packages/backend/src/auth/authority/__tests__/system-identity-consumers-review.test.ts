import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { IncomingMessage, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import postgres from 'postgres';
import { PgBoss } from 'pg-boss';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { BATCH_SYSTEM_USER_COMMAND_PATH, type BatchSystemUserCommand } from '@boardsesh/auth-protocol';
import { BACKGROUND_JOB_QUEUES } from '@boardsesh/db/background-jobs';
import { initializeJobQueueSchema } from '@boardsesh/db/job-queue-schema';
import { claimBackgroundJobRun } from '@boardsesh/db/queries';
import { SYSTEM_BOARD_OWNER_ID, BATCH_SYSTEM_USERS } from '@boardsesh/db/queries/constants';
import {
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  authMigrationEpochs,
  authSubjectCutoffs,
  userBoards,
  users,
  verificationTokens,
  backgroundJobRuns,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { switchIdentityAuthority } from '../router';
import { executeSelectedBatchSystemUserCommand } from '../../current-store/batch-system-user';
import { handleCurrentStoreBatchSystemUsers } from '../../../handlers/current-store-batch-system-users';
import { boardPresenceMutations } from '../../../graphql/resolvers/board-presence/mutations';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { seedAuroraCatalogFixtures } from '../../../__tests__/helpers/board-catalog-fixture';
import * as reverseIdentity from '../reverse-identity';

let environment: Awaited<ReturnType<typeof createEnvironment>>;
// The real mounted board consumer uses its process DB; point only that binding
// at this suite's fresh localhost database, without replacing query behavior.
vi.mock('../../../db/client', () => {
  const database = new Proxy(
    {},
    {
      get(_target, property) {
        const member = Reflect.get(environment.database, property);
        return typeof member === 'function' ? member.bind(environment.database) : member;
      },
    },
  );
  return { db: database, dbRead: database };
});
vi.mock('../../../pubsub/index', () => ({ pubsub: { stampBoardMembership: vi.fn(async () => {}) } }));

let ownerPool: ReturnType<typeof postgres>;
let boss: PgBoss;
const projectionId = randomUUID();
const configuration = { expectedProjectionId: projectionId, expectedNormalizerVersion: 'js-trim-lower-v1' };
const secret = 'owned-system-consumer-machine-secret-6975';
const config = {
  boardType: 'kilter',
  productId: 2100412700,
  layoutId: 2100412701,
  sizeId: 2100412702,
  setIds: [2100412703],
  associationIdBase: 2100412710,
  isListed: false,
};

async function state() {
  return {
    users: await environment.database.select().from(users),
    reservations: await environment.database.select().from(authEmailReservations),
    members: await environment.database.select().from(authEmailReservationMembers),
    boards: await environment.database.select().from(userBoards),
    nonces: await environment.database.select().from(verificationTokens),
  };
}
async function chooseCanonical() {
  await environment.database.transaction((transaction) =>
    switchIdentityAuthority(transaction, {
      projectionId,
      epoch: 1,
      from: 'current-store',
      to: 'better-auth',
    }),
  );
}
async function active(family = 'refresh-recommendations', payload: Record<string, unknown> = {}) {
  const runId = randomUUID();
  await environment.database.insert(backgroundJobRuns).values({
    id: runId,
    queue: BACKGROUND_JOB_QUEUES.batch,
    role: 'batch',
    family,
    payload,
    deadlineAt: new Date(Date.now() + 60000),
  });
  await boss.send(BACKGROUND_JOB_QUEUES.batch, { runId }, { id: runId, singletonKey: runId, expireInSeconds: 600 });
  const [job] = await boss.fetch(BACKGROUND_JOB_QUEUES.batch, { includeMetadata: true, batchSize: 1 });
  if (!job || job.id !== runId) throw new Error('Owned fixture queue did not fetch its actual new attempt');
  const token = await claimBackgroundJobRun(environment.database, runId, job.name, job.retryCount);
  if (!token) throw new Error('Owned fixture queue attempt did not become current');
  return {
    runId,
    token,
    command: {
      protocolVersion: 1,
      operation: 'ensure',
      requestId: randomUUID(),
      issuedAt: Date.now(),
      payload: { runId, attemptToken: token },
    } as BatchSystemUserCommand,
  };
}
async function post(command: BatchSystemUserCommand, headers: Record<string, string> = {}) {
  const request = new IncomingMessage(new Socket());
  request.method = 'POST';
  request.url = BATCH_SYSTEM_USER_COMMAND_PATH;
  request.headers = { 'content-type': 'application/json', authorization: `Bearer ${secret}`, ...headers };
  const captured = {
    statusCode: 0,
    body: '',
    destroyed: false,
    writeHead(status: number) {
      this.statusCode = status;
    },
    end(body?: string) {
      this.body = body ?? '';
    },
  };
  const pending = handleCurrentStoreBatchSystemUsers(
    request,
    captured as unknown as ServerResponse,
    environment.database,
  );
  request.emit('data', Buffer.from(JSON.stringify(command)));
  request.emit('end');
  await pending;
  return { status: captured.statusCode, body: JSON.parse(captured.body) as Record<string, unknown> };
}
function resolve(allowCreate = true) {
  return boardPresenceMutations.resolveBoardForConfig(
    undefined,
    {
      boardType: config.boardType,
      layoutId: config.layoutId,
      sizeId: config.sizeId,
      setIds: String(config.setIds[0]),
    },
    {
      connectionId: randomUUID(),
      isAuthenticated: allowCreate,
      ...(allowCreate ? { userId: 'owned-consumer-requester' } : {}),
    } as ConnectionContext,
  );
}

beforeAll(async () => {
  environment = await createEnvironment();
  const [{ name }] = await environment.client<{ name: string }[]>`SELECT current_database() AS name`;
  const connection = new URL(process.env.AUTH_PROTOTYPE_DATABASE_URL ?? '');
  connection.pathname = `/${name}`;
  ownerPool = postgres(connection.toString(), { max: 1, onnotice: () => {} });
  await ownerPool.unsafe(
    readFileSync(new URL('../../../../../db/drizzle/0241_background_job_runs.sql', import.meta.url), 'utf8'),
  );
  await ownerPool.unsafe(
    readFileSync(new URL('../../../../../db/drizzle/0243_background_job_families.sql', import.meta.url), 'utf8'),
  );
  await initializeJobQueueSchema(drizzle(ownerPool));
  boss = new PgBoss({
    connectionString: connection.toString(),
    max: 1,
    supervise: false,
    schedule: false,
    migrate: false,
    createSchema: false,
  });
  boss.on('error', () => {});
  await boss.start();
  await seedAuroraCatalogFixtures([config]);
});
afterAll(async () => {
  await boss?.stop();
  await ownerPool?.end({ timeout: 5 });
  await environment?.close();
});
beforeEach(async () => {
  vi.stubEnv('AUTH_IDENTITY_MIRROR', 'off');
  vi.stubEnv('DEBUG_SQL', 'false');
  vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'owned-system-consumer-mailbox-digest-6975');
  vi.stubEnv('CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE', 'reserved-staging');
  vi.stubEnv('CURRENT_STORE_BATCH_SYSTEM_USERS_MODE', 'backend-staging');
  vi.stubEnv('CURRENT_STORE_BATCH_SYSTEM_USERS_RPC_SECRET', secret);
  vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
  vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
  vi.stubEnv('AUTH_CUTOFF_ENFORCEMENT', 'enforce');
  await environment.database.delete(userBoards);
  await environment.database.delete(verificationTokens);
  await environment.database.delete(authMigrationEpochs);
  await environment.database.delete(authEmailReservationMembers);
  await environment.database.delete(authEmailReservations);
  await environment.database.delete(authSubjectCutoffs);
  await environment.database.delete(authEmailProjection);
  await environment.database.delete(users);
  await environment.database.transaction(async (transaction) => {
    await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
    await transaction.update(authEmailProjection).set({ phase: 'enforced' });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('actual mounted selected-system consumers on a fresh PostgreSQL fixture', () => {
  it.each(['current-store', 'better-auth'] as const)(
    'mounted board consumer follows %s with the original process epoch and keeps feed policy',
    async (selected) => {
      if (selected === 'better-auth') await chooseCanonical();
      const pending = resolve();
      await expect(pending).resolves.toMatchObject({ boardType: config.boardType });
      const board = await pending;
      const saved = await state();
      expect(saved.users).toEqual([expect.objectContaining({ id: SYSTEM_BOARD_OWNER_ID, emailVerified: null })]);
      expect(saved.reservations).toEqual([
        expect.objectContaining({
          ownerUserId: SYSTEM_BOARD_OWNER_ID,
          basisProjectionId: projectionId,
          state: 'owned',
        }),
      ]);
      expect(saved.members).toEqual([expect.objectContaining({ userId: SYSTEM_BOARD_OWNER_ID })]);
      expect(saved.boards).toEqual([
        expect.objectContaining({
          id: board.boardId,
          ownerId: SYSTEM_BOARD_OWNER_ID,
          isPublic: false,
          isUnlisted: true,
          hideLocation: true,
          isOwned: false,
        }),
      ]);
    },
  );
  it('board legacy selector refuses canonical authority even with forward mirroring disabled', async () => {
    await chooseCanonical();
    vi.stubEnv('CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE', 'legacy');
    const before = await state();
    await expect(resolve()).rejects.toMatchObject({ extensions: { code: 'SERVICE_UNAVAILABLE' } });
    expect(await state()).toEqual(before);
  });
  it('board anonymous create refusal retains zero identity writes', async () => {
    const before = await state();
    await expect(resolve(false)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(await state()).toEqual(before);
  });
  it.each(['current-store', 'better-auth'] as const)(
    'mounted private batch handler follows %s with the original process epoch1',
    async (selected) => {
      if (selected === 'better-auth') await chooseCanonical();
      const { command } = await active();
      expect(await post(command)).toMatchObject({
        status: 200,
        body: { outcome: 'ensured', requestId: command.requestId },
      });
      const saved = await state();
      expect(saved.users).toEqual([
        expect.objectContaining({ id: BATCH_SYSTEM_USERS.recommendations.id, emailVerified: null }),
      ]);
      expect(saved.reservations).toEqual([
        expect.objectContaining({
          ownerUserId: BATCH_SYSTEM_USERS.recommendations.id,
          basisProjectionId: projectionId,
        }),
      ]);
      expect(saved.members).toEqual([expect.objectContaining({ userId: BATCH_SYSTEM_USERS.recommendations.id })]);
      expect(saved.nonces).toHaveLength(1);
    },
  );
  it.each(['wrong-attempt', 'expired-run', 'expired-queue', 'wrong-role', 'wrong-family', 'dry-run', 'no-shadow'])(
    'mounted batch %s gate retains zero system identity or nonce writes',
    async (fault) => {
      await chooseCanonical();
      const classifier = fault === 'dry-run' || fault === 'no-shadow';
      const current = await active(
        classifier ? 'refresh-hold-features' : 'refresh-recommendations',
        fault === 'dry-run' ? { dryRun: true } : fault === 'no-shadow' ? { shadow: false } : {},
      );
      if (fault === 'wrong-attempt') current.command.payload.attemptToken = randomUUID();
      if (fault === 'expired-run')
        await environment.database
          .update(backgroundJobRuns)
          .set({ deadlineAt: new Date(Date.now() - 1000) })
          .where(eq(backgroundJobRuns.id, current.runId));
      if (fault === 'expired-queue')
        await ownerPool`UPDATE pgboss.job SET started_on = now() - interval '1 day' WHERE id = ${current.runId}`;
      if (fault === 'wrong-role')
        await environment.database
          .update(backgroundJobRuns)
          .set({ role: 'interactive-import' })
          .where(eq(backgroundJobRuns.id, current.runId));
      if (fault === 'wrong-family')
        await environment.database
          .update(backgroundJobRuns)
          .set({ family: 'worker-probe' })
          .where(eq(backgroundJobRuns.id, current.runId));
      const before = await state();
      const reply = await post(current.command);
      expect(reply.body.outcome).toBe('rejected');
      expect(reply.status).toBeGreaterThanOrEqual(400);
      expect(await state()).toEqual(before);
    },
  );
  it.each(['current-store', 'better-auth'] as const)(
    'mounted classifier write flags permit a valid %s system request',
    async (selected) => {
      if (selected === 'better-auth') await chooseCanonical();
      const current = await active('refresh-hold-features', { dryRun: false, shadow: true });
      expect(await post(current.command)).toMatchObject({ status: 200, body: { outcome: 'ensured' } });
      const saved = await state();
      expect(saved.users).toEqual([expect.objectContaining({ id: BATCH_SYSTEM_USERS['hold-classifier'].id })]);
      expect(saved.reservations).toEqual([
        expect.objectContaining({ ownerUserId: BATCH_SYSTEM_USERS['hold-classifier'].id }),
      ]);
      expect(saved.members).toEqual([expect.objectContaining({ userId: BATCH_SYSTEM_USERS['hold-classifier'].id })]);
      expect(saved.nonces).toHaveLength(1);
    },
  );
  it('expired command deadline refuses a valid real queue attempt before identity writes', async () => {
    const current = await active();
    const before = await state();
    await expect(
      executeSelectedBatchSystemUserCommand(
        environment.database,
        configuration,
        current.command,
        performance.now() - 1,
      ),
    ).rejects.toMatchObject({ code: 'request_expired' });
    expect(await state()).toEqual(before);
  });
  it('actual post-write job deadline expiry rolls back canonical identity, reservation and nonce', async () => {
    await chooseCanonical();
    const current = await active();
    const before = await state();
    const actual = reverseIdentity.mirrorAuthorityToCurrentStore;
    vi.spyOn(reverseIdentity, 'mirrorAuthorityToCurrentStore').mockImplementationOnce(async (transaction, userId) => {
      await actual(transaction, userId);
      await transaction
        .update(backgroundJobRuns)
        .set({ deadlineAt: new Date(Date.now() - 1000) })
        .where(eq(backgroundJobRuns.id, current.runId));
    });
    expect(await post(current.command)).toMatchObject({ body: { outcome: 'rejected', code: 'attempt_lost' } });
    expect(await state()).toEqual(before);
  });
  it('batch browser-origin rejection precedes nonce or system writes', async () => {
    const current = await active();
    const before = await state();
    expect((await post(current.command, { origin: 'https://browser.invalid' })).status).toBe(401);
    expect(await state()).toEqual(before);
  });
});
