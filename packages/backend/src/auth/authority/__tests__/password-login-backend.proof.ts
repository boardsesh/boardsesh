import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { hash } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  AUTH_PROTOCOL_VERSION,
  PRE_ENFORCEMENT_PASSWORD_PATH,
  preEnforcementPasswordReplySchema,
  type PasswordReply,
} from '@boardsesh/auth-protocol';
import {
  users,
  userCredentials,
  authEmailProjection,
  authSubjectCutoffs,
  authSession,
  authSecurityMutationEvents,
  mobileRefreshTokens,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { createCredentialWriterEnvironment, ownedCredentialProofUrl } from './fixtures/credential-writer-environment';
import { getCredentialDatabase, closeCredentialDatabase } from '../../credential-database';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { handleCurrentStorePasswordLogin } from '../../../handlers/current-store-password-login';
import { createPasswordLoginLimiter } from '../../current-store/password-login-limits';
import { createPasswordCompareGate } from '../../current-store/password-compare-gate';
import { resetAllRateLimits } from '../../../utils/rate-limiter';

const comparison = vi.hoisted(() => ({ after: undefined as (() => Promise<void>) | undefined }));
vi.mock('bcryptjs', async (original) => {
  const actual = await original<typeof import('bcryptjs')>();
  return {
    ...actual,
    compare: async (password: string, passwordHash: string) => {
      const accepted = await actual.compare(password, passwordHash);
      await comparison.after?.();
      return accepted;
    },
  };
});
vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error('UNUSED_CONTENT_POOL');
      },
    },
  ),
}));
const rpcSecret = 'owned-password-login-private-rpc-secret-6975';
const copyName = `epic6975_identity_import_${randomUUID().replaceAll('-', '')}`;
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let admin: postgres.Sql;
let server: Server;
let origin: string;
let guards: Parameters<typeof handleCurrentStorePasswordLogin>[3];
function command(email = 'owner@example.test', password = ' raw password ') {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'password',
    credentialProofVersion: 1,
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { email, password },
  };
}
async function post(
  input: unknown = command(),
  headers: Record<string, string> = {},
  path = PRE_ENFORCEMENT_PASSWORD_PATH,
) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rpcSecret}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(input),
  });
  return { status: response.status, body: (await response.json()) as PasswordReply };
}
async function seed(email = 'owner@example.test', password: string | null = ' raw password ') {
  const id = randomUUID();
  await environment.ownerDatabase
    .insert(users)
    .values({ id, email, name: 'Climber', createdAt: new Date('2020-01-01'), emailVerified: new Date('2020-01-01') });
  if (password !== null)
    await environment.ownerDatabase
      .insert(userCredentials)
      .values({ userId: id, passwordHash: await hash(password, 4) });
  return id;
}
describe('backend-first pre-enforcement password proofs through restricted LOGIN', () => {
  beforeAll(async () => {
    const target = ownedCredentialProofUrl();
    const template = target.pathname.slice(1);
    target.pathname = '/postgres';
    admin = postgres(target.toString(), { max: 2, onnotice: () => {} });
    const [present] = await admin<
      { present: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=${template}) AS present`;
    if (!present?.present) throw new Error('OWNED_PASSWORD_TEMPLATE_MISSING');
    await admin.unsafe(`CREATE DATABASE "${copyName}" TEMPLATE "${template}"`);
    environment = await createCredentialWriterEnvironment('private-registration-v1', { copyDatabase: copyName });
    server = createServer((request, response) => {
      void handleCurrentStorePasswordLogin(request, response, undefined, guards).catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned binding missing');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    await closeCredentialDatabase();
    comparison.after = undefined;
    await environment.owner`DELETE FROM public.users`;
    await environment.owner.unsafe(
      'TRUNCATE auth_email_projection,auth_subject_cutoffs,auth_security_mutation_events,"verificationTokens" CASCADE',
    );
    for (const [name, content] of Object.entries({
      DATABASE_URL: environment.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: 'private-registration-v1',
      CURRENT_STORE_WEB_AUTH_MODE: 'legacy',
      CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE: 'off',
      CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
      NEXTAUTH_SECRET: 'owned-password-login-jwt-secret',
      DEBUG_SQL: 'false',
      AUTH_IDENTITY_MIRROR: 'off',
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      AUTH_ACCOUNT_GUESS_LIMIT_MODE: 'off',
      EMAIL_VERIFICATION_ENABLED: 'false',
    }))
      vi.stubEnv(name, content);
    resetAllRateLimits();
    guards = { limits: createPasswordLoginLimiter({ redis: () => null }), gate: createPasswordCompareGate() };
  });
  afterEach(async () => {
    comparison.after = undefined;
    await closeCredentialDatabase();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await environment?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${copyName}"`);
      await admin.end();
    }
  });
  it.each([false, true])(
    'returns mandatory genuine password proof without staged configuration, prepared=%s',
    async (prepared) => {
      const userId = await seed();
      if (prepared)
        await environment.ownerDatabase.transaction((transaction) =>
          prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
        );
      const [before] = await environment.owner<{ instant: Date }[]>`SELECT clock_timestamp() AS instant`;
      const response = await post();
      expect(response.status).toBe(200);
      const reply = preEnforcementPasswordReplySchema.parse(response.body);
      if (reply.outcome !== 'authenticated' || !reply.credentialProof) throw new Error('Proof missing');
      const [after] = await environment.owner<{ instant: Date }[]>`SELECT clock_timestamp() AS instant`;
      expect(reply.credentialProof).toMatchObject({ userId, version: 1, generation: 0, linkGuarded: true });
      const authenticatedAt = Date.parse(reply.credentialProof.authenticatedAt ?? '');
      expect(authenticatedAt).toBeGreaterThanOrEqual(new Date(before.instant).getTime() - 1);
      expect(authenticatedAt).toBeLessThanOrEqual(new Date(after.instant).getTime() + 1);
      for (const relation of [authSession, authSubjectCutoffs, authSecurityMutationEvents, mobileRefreshTokens])
        expect(await environment.ownerDatabase.select().from(relation)).toHaveLength(0);
      expect(await environment.ownerDatabase.select().from(verificationTokens)).toHaveLength(1);
    },
  );
  it.each([
    ['MiXeD@example.test', 'mixed@example.test', 'x', 'x', true],
    ['MiXeD@example.test', 'MiXeD@example.test', 'x', 'x', true],
    ['percent_%@example.test', 'percent_%@example.test', 'x', 'x', true],
    ['  whitespace@example.test  ', '  whitespace@example.test  ', 'x', 'x', true],
    ['Ünicode@example.test', 'Ünicode@example.test', 'é\u0301 ', 'é\u0301 ', true],
    ['short@example.test', 'short@example.test', 'x', 'x', true],
    ['spaces@example.test', 'spaces@example.test', ' raw ', 'raw', false],
    ['unicode-password@example.test', 'unicode-password@example.test', 'é', 'e\u0301', false],
    ['long@example.test', 'long@example.test', 'a'.repeat(140), 'a'.repeat(140), true],
  ])('preserves lookup/password semantics for %s', async (stored, typed, actual, submitted, accepted) => {
    const userId = await seed(stored, actual);
    const reply = (await post(command(typed, submitted))).body;
    expect(reply.outcome).toBe(accepted ? 'authenticated' : 'invalid_credentials');
    if (reply.outcome === 'authenticated') expect(reply.user.id).toBe(userId);
  });
  it('uses exact-first and bounded duplicate-password ownership, including OAuth-only siblings', async () => {
    const exact = await seed('Mixed@example.test', 'one');
    await seed('mixed@example.test', 'two');
    expect((await post(command('Mixed@example.test', 'two'))).body.outcome).toBe('invalid_credentials');
    const accepted = (await post(command('Mixed@example.test', 'one'))).body;
    expect(accepted.outcome === 'authenticated' && accepted.user.id).toBe(exact);
    expect((await post(command('MIXED@example.test', 'one'))).body.outcome).toBe('invalid_credentials');
    await seed('duplicate@example.test', null);
    const ownerId = await seed('duplicate@example.test', 'one');
    const unique = (await post(command('duplicate@example.test', 'one'))).body;
    expect(unique.outcome === 'authenticated' && unique.user.id).toBe(ownerId);
    await seed('duplicate@example.test', 'one');
    expect((await post(command('duplicate@example.test', 'one'))).body.outcome).toBe('invalid_credentials');
  });
  it('does not let percent or underscore match other addresses', async () => {
    await seed('literalab@example.test', 'x');
    expect((await post(command('literal_%@example.test', 'x'))).body.outcome).toBe('invalid_credentials');
  });
  it.each(['hash', 'generation', 'cohort', 'enforcement'] as const)(
    'refuses %s changed after actual bcrypt',
    async (change) => {
      const userId = await seed();
      comparison.after = async () => {
        comparison.after = undefined;
        if (change === 'hash')
          await environment.ownerDatabase
            .update(userCredentials)
            .set({ passwordHash: await hash('replacement password', 4) })
            .where(eq(userCredentials.userId, userId));
        if (change === 'generation')
          await environment.ownerDatabase
            .insert(authSubjectCutoffs)
            .values({ userId, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
        if (change === 'cohort') await seed('owner@example.test', null);
        if (change === 'enforcement') {
          await environment.ownerDatabase.transaction((transaction) =>
            prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
          );
          await environment.ownerDatabase.update(authEmailProjection).set({ phase: 'enforced' });
        }
      };
      const response = await post();
      expect(response.status).toBe(change === 'enforcement' ? 503 : 200);
      if (change !== 'enforcement') expect(response.body.outcome).toBe('invalid_credentials');
    },
  );
  it('rereads after an observed user-lock wait and refuses the fixture cutoff committed during that wait', async () => {
    const userId = await seed();
    let releaseLock!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      lockHeld = resolve;
    });
    let mutation: Promise<void> | undefined;
    comparison.after = async () => {
      comparison.after = undefined;
      mutation = environment.ownerDatabase.transaction(async (transaction) => {
        await transaction.select().from(users).where(eq(users.id, userId)).for('update');
        lockHeld();
        await released;
        await transaction
          .update(userCredentials)
          .set({ passwordHash: await hash('replacement password', 4) })
          .where(eq(userCredentials.userId, userId));
        await transaction
          .insert(authSubjectCutoffs)
          .values({ userId, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
      });
      await held;
    };
    const pending = post();
    await held;
    try {
      const deadline = Date.now() + 1500;
      let observed = false;
      while (Date.now() < deadline && !observed) {
        const [state] = await admin<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=${copyName} AND wait_event_type='Lock' AND query ILIKE '%for key share%') AS waiting`;
        observed = state.waiting;
        if (!observed) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(observed).toBe(true);
    } finally {
      releaseLock();
    }
    await mutation;
    expect((await pending).body.outcome).toBe('invalid_credentials');
  });
  it('keeps timed-out pool work in custody and writes no late proof nonce', async () => {
    await seed();
    const credentials = await getCredentialDatabase('private-registration-v1');
    let releasePool!: () => void;
    const released = new Promise<void>((resolve) => {
      releasePool = resolve;
    });
    let poolHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      poolHeld = resolve;
    });
    let active = 0;
    const holders = [0, 1].map(() =>
      credentials.transaction(async (transaction) => {
        await transaction.execute(sql`SELECT 1`);
        active += 1;
        if (active === 2) poolHeld();
        await released;
      }),
    );
    await held;
    const gate = createPasswordCompareGate({ maxWaiting: 0 });
    guards = { limits: createPasswordLoginLimiter({ redis: () => null }), gate };
    try {
      const response = await post();
      expect(response.status).toBe(503);
      expect(gate.isFull()).toBe(true);
      expect(await environment.ownerDatabase.select().from(verificationTokens)).toHaveLength(0);
      expect((await post()).status).toBe(503);
    } finally {
      releasePool();
      await Promise.all(holders);
    }
    const deadline = Date.now() + 2000;
    while (gate.isFull() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gate.isFull()).toBe(false);
    expect(await environment.ownerDatabase.select().from(verificationTokens)).toHaveLength(0);
  });
  it('refunds exactly the participating accepted/replayed/unavailable attempts, retaining rejected guesses', async () => {
    await seed();
    const giveBack = vi.fn(async () => {});
    guards = { limits: { admit: async () => ({ giveBack }) }, gate: createPasswordCompareGate() };
    expect((await post(command('owner@example.test', 'wrong'))).body.outcome).toBe('invalid_credentials');
    expect(giveBack).not.toHaveBeenCalled();
    const request = command();
    expect((await post(request)).body.outcome).toBe('authenticated');
    expect(giveBack).toHaveBeenCalledTimes(1);
    expect((await post(request)).body.outcome).toBe('error');
    expect(giveBack).toHaveBeenCalledTimes(2);
    vi.stubEnv('AUTH_IDENTITY_DATABASE_CONTRACT', 'private-web-v1');
    expect((await post()).status).toBe(503);
    expect(giveBack).toHaveBeenCalledTimes(3);
  });
  it('never acknowledges a replay as a second authentication', async () => {
    await seed();
    const request = command();
    expect((await post(request)).body.outcome).toBe('authenticated');
    expect((await post(request)).body).toMatchObject({ outcome: 'error', code: 'replayed' });
  });
  it.each(['current-store', 'better-auth'] as const)(
    'refuses enforced %s without nonce writes',
    async (writerAuthority) => {
      await seed();
      await environment.ownerDatabase.transaction((transaction) =>
        prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
      );
      await environment.ownerDatabase.update(authEmailProjection).set({ phase: 'enforced', writerAuthority });
      expect((await post()).status).toBe(503);
      expect(await environment.ownerDatabase.select().from(verificationTokens)).toHaveLength(0);
    },
  );
  it.each(['missing-proof', 'wrong-proof', 'session', 'old', 'wrong-operation'] as const)(
    'rejects unsupported command %s before domain work',
    async (invalid) => {
      await seed();
      const request: Record<string, unknown> = command();
      if (invalid === 'missing-proof') delete request.credentialProofVersion;
      if (invalid === 'wrong-proof') request.credentialProofVersion = 2;
      if (invalid === 'session') request.webSession = {};
      if (invalid === 'old') request.issuedAt = 0;
      if (invalid === 'wrong-operation') request.operation = 'register';
      expect((await post(request)).status).toBe(400);
      expect(await environment.ownerDatabase.select().from(verificationTokens)).toHaveLength(0);
    },
  );
  it.each(['DEBUG_SQL', 'AUTH_CUTOFF_ENFORCEMENT'] as const)('refuses unsafe %s configuration', async (setting) => {
    vi.stubEnv(setting, setting === 'DEBUG_SQL' ? 'true' : 'observe');
    expect((await post()).status).toBe(503);
  });
});
