import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { compare, hash } from 'bcryptjs';
import { decodeJwt } from 'jose';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { executeFirstRow, type DbInstance } from '@boardsesh/db/client';
import * as schema from '@boardsesh/db/schema';
import {
  AUTH_PROTOCOL_VERSION,
  RECOVERY_COMMAND_PATHS,
  forgotPasswordReplySchema,
  resetPasswordReplySchema,
  type ResetPasswordCommand,
} from '@boardsesh/auth-protocol';
import {
  users,
  userCredentials,
  verificationTokens,
  authSubjectCutoffs,
  authPreEnforcementPasswordResetEvents,
  authPasswordChangeEvidence,
  mobileRefreshTokens,
  authSecurityMutationEvents,
  authSession,
} from '@boardsesh/db/schema/auth';
import { qualifyCredentialWriter } from '@boardsesh/db/credential-writer-acl';
import {
  createCredentialWriterEnvironment,
  grantOwnedCredentialWriterCapabilities,
  ownedCredentialProofUrl,
} from './fixtures/credential-writer-environment';
import { closeCredentialDatabase, getCredentialDatabase } from '../../credential-database';
import { passwordFingerprint } from '../../password-change-evidence';
import { consumeRecoveryBeforeEnforcement } from '../../current-store/password-recovery-family';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { createRecoveryCommandGuards, type RecoveryCommandGuards } from '../../current-store/recovery-command-limits';
import { handleCurrentStoreRecovery } from '../../../handlers/current-store-recovery';
import { getPostgresErrorCode } from '../../../utils/postgres-errors';
import {
  createApp,
  attachPartnerState,
  readPartnerState,
  countsOf,
  INTACT_COUNTS,
  REVOKED_COUNTS,
} from '../../partner/__tests__/revocation-fixtures';

const hooks = vi.hoisted(() => ({
  afterHash: undefined as (() => Promise<void>) | undefined,
  seedDatabase: undefined as DbInstance | undefined,
  allowFixtureIo: false,
}));
vi.mock('bcryptjs', async (original) => {
  const actual = await original<typeof import('bcryptjs')>();
  const hashPassword = async (password: string, cost: number | string) => {
    const result = await actual.hash(password, cost);
    await hooks.afterHash?.();
    return result;
  };
  return { ...actual, hash: hashPassword, default: { ...actual.default, hash: hashPassword } };
});
vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get(_target, property) {
        if (!hooks.allowFixtureIo || !hooks.seedDatabase) throw new Error('UNEXPECTED_CONTENT_CREDENTIAL_DATABASE');
        const member: unknown = Reflect.get(hooks.seedDatabase, property);
        return typeof member === 'function' ? member.bind(hooks.seedDatabase) : member;
      },
    },
  ),
}));
const secret = 'owned-private-recovery-command-rpc-secret-6975';
const copyName = `epic6975_identity_import_${randomUUID().replaceAll('-', '')}`;
const originalPassword = 'owned-original-password';
const replacementPassword = ' raw new e\u0301 password ';
let fixture: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let admin: postgres.Sql;
let server: Server;
let origin: string;
let guards: RecoveryCommandGuards;
let restoreGrants = false;
const active = new Set<Promise<void>>();
function command(operation: 'forgot-password' | 'reset-password', payload: unknown) {
  return { protocolVersion: AUTH_PROTOCOL_VERSION, operation, requestId: randomUUID(), issuedAt: Date.now(), payload };
}
async function post(
  operation: 'forgot-password' | 'reset-password',
  payload: unknown,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  const response = await fetch(`${origin}${RECOVERY_COMMAND_PATHS[operation]}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
    signal,
  });
  const body = (await response.json()) as Record<string, unknown>;
  if ('protocolVersion' in body) {
    const reply = (operation === 'forgot-password' ? forgotPasswordReplySchema : resetPasswordReplySchema).parse(body);
    const envelope = payload as { requestId?: unknown };
    expect(reply).toMatchObject({ protocolVersion: 2, operation, requestId: envelope.requestId });
    // Independent wire-contract expectations, deliberately not authCommandReplyStatus.
    if (reply.outcome !== 'error') {
      const outcomeStatuses = { accepted: 200, reset: 200, invalid_or_expired: 200, legacy_unbound: 503 };
      expect(response.status).toBe(outcomeStatuses[reply.outcome]);
    } else {
      const errorStatuses: Record<string, number> = {
        replayed: 409,
        validation_error: 400,
        rate_limited: 429,
        unavailable: 503,
      };
      expect(errorStatuses).toHaveProperty(reply.code);
      expect(response.status).toBe(errorStatuses[reply.code]);
    }
  }
  return { status: response.status, body, cookies: response.headers.getSetCookie() };
}
function expectPrivateInvalid(result: Awaited<ReturnType<typeof post>>) {
  expect(result.status).toBe(200);
  expect(resetPasswordReplySchema.parse(result.body).outcome).toBe('invalid_or_expired');
  expect(result.cookies).toEqual([]);
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function waitFor(condition: () => Promise<boolean> | boolean, duration = 2000) {
  const deadline = Date.now() + duration;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error('Owned proof observation deadline');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function expectUnavailable(result: Awaited<ReturnType<typeof post>>) {
  expect(result.status).toBe(503);
  expect(result.body).toMatchObject({ outcome: 'error', code: 'unavailable' });
  expect(result.cookies).toEqual([]);
}
async function assertUnconsumed(userId: string, token: string) {
  const state = await stored(userId);
  expect(state.cutoff).toBeUndefined();
  expect(state.events).toEqual([]);
  expect(
    (await fixture.ownerDatabase.select().from(verificationTokens)).some(
      (row) => row.token === createHash('sha256').update(token).digest('hex'),
    ),
  ).toBe(true);
  expect(await fixture.ownerDatabase.select().from(authPasswordChangeEvidence)).toEqual([]);
}
async function seed(
  email = 'MiXeD+tag@example.test',
  password: string | null = originalPassword,
  verified: Date | null = null,
) {
  const id = randomUUID();
  await fixture.ownerDatabase
    .insert(users)
    .values({ id, email, createdAt: new Date('2020-01-01'), emailVerified: verified });
  if (password !== null)
    await fixture.ownerDatabase.insert(userCredentials).values({ userId: id, passwordHash: await hash(password, 4) });
  return { id, email };
}
async function legacyLink(email: string, expires = new Date(Date.now() + 3_600_000)) {
  const token = randomUUID();
  await fixture.ownerDatabase.insert(verificationTokens).values({
    identifier: `password-reset:${email}`,
    token: createHash('sha256').update(token).digest('hex'),
    expires,
  });
  return token;
}
function resetPayload(email: string, token: string, password = replacementPassword) {
  return { email, token, password, confirmPassword: password };
}
async function uidLink(email: string) {
  const reply = await post('forgot-password', command('forgot-password', { email }));
  expect(reply.status).toBe(200);
  const parsed = forgotPasswordReplySchema.parse(reply.body);
  if (parsed.outcome !== 'accepted' || !parsed.mailPlan) throw new Error('Owned UID receipt missing');
  return parsed.mailPlan.token;
}
async function stored(userId: string) {
  const [credential] = await fixture.ownerDatabase
    .select()
    .from(userCredentials)
    .where(eq(userCredentials.userId, userId));
  const [cutoff] = await fixture.ownerDatabase
    .select()
    .from(authSubjectCutoffs)
    .where(eq(authSubjectCutoffs.userId, userId));
  const events = await fixture.ownerDatabase
    .select()
    .from(authPreEnforcementPasswordResetEvents)
    .where(eq(authPreEnforcementPasswordResetEvents.userId, userId));
  return { credential, cutoff, events };
}
async function withFixtureIo<T>(work: () => Promise<T>) {
  hooks.allowFixtureIo = true;
  try {
    return await work();
  } finally {
    hooks.allowFixtureIo = false;
  }
}
const qualify = (contract: 'private-recovery-v1' | 'private-registration-evidence-v1' = 'private-recovery-v1') =>
  qualifyCredentialWriter(fixture.writer, {
    expectedRole: 'boardsesh_identity_writer',
    expectedDatabase: fixture.databaseName,
    contract,
  });

// Every catalog and mutation below belongs to this suite's isolated synthetic copy.
describe('pre-enforcement recovery through exact restricted LOGIN and real HTTP', () => {
  beforeAll(async () => {
    const target = ownedCredentialProofUrl();
    const template = target.pathname.slice(1);
    target.pathname = '/postgres';
    admin = postgres(target.toString(), { max: 2, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${copyName}" TEMPLATE "${template}"`);
    fixture = await createCredentialWriterEnvironment('private-recovery-v1', { copyDatabase: copyName });
    hooks.seedDatabase = fixture.ownerDatabase;
    server = createServer((request, response) => {
      const pending = (
        request.url === '/auth/native/refresh'
          ? withFixtureIo(async () =>
              (await import('../../../handlers/native-auth')).handleNativeAuthRefresh(request, response),
            )
          : handleCurrentStoreRecovery(request, response, undefined, guards)
      ).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
      active.add(pending);
      void pending.finally(() => active.delete(pending));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned recovery binding missing');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    await closeCredentialDatabase();
    hooks.afterHash = undefined;
    hooks.allowFixtureIo = false;
    await fixture.owner`DELETE FROM public.users`;
    await fixture.owner.unsafe(
      'TRUNCATE auth_email_projection,auth_subject_cutoffs,auth_password_recovery_state,auth_pre_enforcement_password_reset_events,auth_security_mutation_events,"verificationTokens" CASCADE',
    );
    for (const [name, content] of Object.entries({
      DATABASE_URL: fixture.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: fixture.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: 'private-recovery-v1',
      CURRENT_STORE_AUTH_RPC_SECRET: secret,
      CURRENT_STORE_WEB_AUTH_MODE: 'legacy',
      AUTH_IDENTITY_MIRROR: 'off',
      AUTH_PASSWORD_CHANGE_EVIDENCE_MODE: 'off',
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      AUTH_ACCOUNT_GUESS_LIMIT_MODE: 'off',
      DEBUG_SQL: 'false',
      AUTH_DEVICE_TOKEN_SECRET: '',
      NEXTAUTH_SECRET: 'owned-recovery-native-jwt-secret-6975',
      AUTH_LEGACY_BRIDGE_MODE: 'off',
      AUTH_NATIVE_REVOCATION_MODE: 'legacy',
    }))
      vi.stubEnv(name, content);
    guards = createRecoveryCommandGuards({ redis: () => null });
  });
  afterEach(async () => {
    hooks.afterHash = undefined;
    await Promise.allSettled(active);
    await closeCredentialDatabase();
    if (restoreGrants) {
      await fixture.resetGrants();
      restoreGrants = false;
    }
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${copyName}"`);
      await admin.end();
    }
  });

  it.each([false, true])(
    'consumes UUID once with real hash/cutoff/ledger and no login, prepared=%s',
    async (prepared) => {
      const account = await seed();
      const token = await legacyLink(account.email);
      if (prepared)
        await fixture.ownerDatabase.transaction((transaction) =>
          prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
        );
      const [before] = await fixture.owner<{ instant: Date }[]>`SELECT clock_timestamp() AS instant`;
      const input = command('reset-password', resetPayload(account.email, token));
      const result = await post('reset-password', input);
      expect(result.status).toBe(200);
      expect(resetPasswordReplySchema.parse(result.body).outcome).toBe('reset');
      expect(result.cookies).toEqual([]);
      const changed = await stored(account.id);
      expect(await compare(replacementPassword, changed.credential.passwordHash)).toBe(true);
      expect(await compare(originalPassword, changed.credential.passwordHash)).toBe(false);
      expect(changed.cutoff).toMatchObject({ generation: 1, nativeGeneration: 0, lastOperationId: input.requestId });
      expect(changed.events).toHaveLength(1);
      expect(changed.events[0]).toMatchObject({
        generation: 1,
        previousGeneration: 0,
        kind: 'password-reset',
        domains: ['first-party', 'partner'],
        contextPhase: prepared ? 'prepared' : 'absent',
      });
      expect(changed.events[0].recordedAt.getTime()).toBeGreaterThanOrEqual(new Date(before.instant).getTime() - 1);
      if (!prepared) expect(changed.events[0]).toMatchObject({ preparedProjectionId: null, preparedWriterEpoch: null });
      expect(await fixture.ownerDatabase.select().from(authSecurityMutationEvents)).toEqual([]);
      expect(await fixture.ownerDatabase.select().from(authSession)).toEqual([]);
      expect(await fixture.ownerDatabase.select().from(authPasswordChangeEvidence)).toEqual([]);
      expectPrivateInvalid(await post('reset-password', command('reset-password', resetPayload(account.email, token))));
      const replay = await post('reset-password', input);
      expect(replay.status).toBe(409);
      expect(replay.body).toMatchObject({
        protocolVersion: 2,
        operation: 'reset-password',
        requestId: input.requestId,
        outcome: 'error',
        code: 'replayed',
      });
      expect(replay.cookies).toEqual([]);
      expect((await stored(account.id)).events).toHaveLength(1);
    },
  );
  it('uses immutable UID despite a valid but wrong email hint and preserves existing verification time', async () => {
    const stamp = new Date('2021-02-03T00:00:00Z');
    const account = await seed('owner@example.test', originalPassword, stamp);
    const sibling = await seed('sibling@example.test');
    const token = await uidLink(account.email);
    expect((await post('reset-password', command('reset-password', resetPayload(sibling.email, token)))).status).toBe(
      200,
    );
    expect((await stored(account.id)).cutoff.generation).toBe(1);
    expect((await stored(sibling.id)).cutoff).toBeUndefined();
    const [user] = await fixture.ownerDatabase.select().from(users).where(eq(users.id, account.id));
    expect(user.emailVerified).toEqual(stamp);
  });
  it('captures the exact actual replacement hash and DB time when evidence is on', async () => {
    vi.stubEnv('AUTH_PASSWORD_CHANGE_EVIDENCE_MODE', 'on');
    const account = await seed();
    const token = await legacyLink(account.email);
    const [before] = await fixture.owner<{ instant: Date }[]>`SELECT clock_timestamp() AS instant`;
    expect((await post('reset-password', command('reset-password', resetPayload(account.email, token)))).status).toBe(
      200,
    );
    const changed = await stored(account.id);
    const [evidence] = await fixture.ownerDatabase
      .select()
      .from(authPasswordChangeEvidence)
      .where(eq(authPasswordChangeEvidence.userId, account.id));
    expect(evidence.passwordFingerprint).toBe(passwordFingerprint(changed.credential.passwordHash));
    expect(evidence.changedAt.getTime()).toBeGreaterThanOrEqual(new Date(before.instant).getTime() - 1);
  });
  it('performs no evidence relation SQL when capture is off', async () => {
    const account = await seed();
    const token = await legacyLink(account.email);
    const statements: string[] = [];
    const traced = drizzle(fixture.writer, {
      schema,
      logger: {
        logQuery(query) {
          statements.push(query);
        },
      },
    });
    await qualify();
    const reply = await consumeRecoveryBeforeEnforcement(
      traced,
      command('reset-password', resetPayload(account.email, token)) as ResetPasswordCommand,
    );
    expect(reply.outcome).toBe('reset');
    expect(statements.some((statement) => statement.includes('auth_password_change_evidence'))).toBe(false);
  });
  it('retains OAuth-only legacy-token insertion compatibility but never issues a UID link for it', async () => {
    const account = await seed('oauth@example.test', null);
    const omitted = forgotPasswordReplySchema.parse(
      (await post('forgot-password', command('forgot-password', { email: account.email }))).body,
    );
    expect(omitted).not.toHaveProperty('mailPlan');
    const token = await legacyLink(account.email);
    expect((await post('reset-password', command('reset-password', resetPayload(account.email, token)))).status).toBe(
      200,
    );
    expect((await stored(account.id)).cutoff.generation).toBe(1);
  });
  it('preserves the original long/microsecond deadline and never caps a legacy link at one hour', async () => {
    const account = await seed();
    const token = await legacyLink(account.email, new Date(Date.now() + 7 * 86_400_000));
    await fixture.owner`UPDATE public."verificationTokens" SET expires=expires+interval '0.000123 seconds' WHERE identifier=${'password-reset:' + account.email}`;
    expect((await post('reset-password', command('reset-password', resetPayload(account.email, token)))).status).toBe(
      200,
    );
  });
  it.each(['America/Los_Angeles', 'Pacific/Auckland'])(
    'uses UTC legacy deadlines in a non-UTC credential session: %s',
    async (timezone) => {
      const expired = await seed('expired@example.test');
      const live = await seed('live@example.test');
      const expiredToken = await legacyLink(expired.email);
      const liveToken = await legacyLink(live.email);
      await fixture.owner`UPDATE public."verificationTokens" SET expires=(clock_timestamp() AT TIME ZONE 'UTC')-interval '30 minutes' WHERE identifier=${'password-reset:' + expired.email}`;
      await fixture.owner`UPDATE public."verificationTokens" SET expires=(clock_timestamp() AT TIME ZONE 'UTC')+interval '30 minutes 0.000123 seconds' WHERE identifier=${'password-reset:' + live.email}`;
      const [original] = await fixture.owner<
        { expires: string }[]
      >`SELECT expires::text AS expires FROM public."verificationTokens" WHERE identifier=${'password-reset:' + expired.email}`;
      const databaseIdentifier = '"' + fixture.databaseName.replaceAll('"', '""') + '"';
      await fixture.owner.unsafe(
        `ALTER ROLE boardsesh_identity_writer IN DATABASE ${databaseIdentifier} SET TimeZone TO '${timezone}'`,
      );
      try {
        const privateDatabase = await getCredentialDatabase('private-recovery-v1');
        const session = await executeFirstRow<{ timezone: string }>(
          privateDatabase,
          sql`SELECT current_setting('TimeZone') AS timezone`,
        );
        expect(session?.timezone).toBe(timezone);
        expectPrivateInvalid(
          await post('reset-password', command('reset-password', resetPayload(expired.email, expiredToken))),
        );
        const [retained] = await fixture.owner<
          { expires: string }[]
        >`SELECT expires::text AS expires FROM public."verificationTokens" WHERE identifier=${'password-reset:' + expired.email}`;
        expect(retained).toEqual(original);
        expect((await stored(expired.id)).cutoff).toBeUndefined();
        expect(
          (await post('reset-password', command('reset-password', resetPayload(live.email, liveToken)))).status,
        ).toBe(200);
        expectPrivateInvalid(
          await post('reset-password', command('reset-password', resetPayload(live.email, liveToken))),
        );
        expect((await stored(live.id)).events).toHaveLength(1);
      } finally {
        await closeCredentialDatabase();
        await fixture.owner.unsafe(
          `ALTER ROLE boardsesh_identity_writer IN DATABASE ${databaseIdentifier} RESET TimeZone`,
        );
      }
    },
  );
  it('does not consume another spelling, wrong token, new owner or duplicate exact-address row', async () => {
    const account = await seed();
    const token = await legacyLink(account.email);
    expectPrivateInvalid(
      await post('reset-password', command('reset-password', resetPayload(account.email.toLowerCase(), token))),
    );
    expectPrivateInvalid(
      await post('reset-password', command('reset-password', resetPayload(account.email, randomUUID()))),
    );
    await seed(account.email);
    expectPrivateInvalid(await post('reset-password', command('reset-password', resetPayload(account.email, token))));
    expect(
      (await fixture.ownerDatabase.select().from(verificationTokens)).filter(
        (row) => row.identifier === 'password-reset:' + account.email,
      ),
    ).toHaveLength(1);
    expect((await stored(account.id)).events).toEqual([]);
  });
  it.each(['observe', 'invalid'])('refuses reader enforcement %s before any consumption', async (mode) => {
    const account = await seed();
    const token = await legacyLink(account.email);
    vi.stubEnv('AUTH_CUTOFF_ENFORCEMENT', mode);
    expect((await post('reset-password', command('reset-password', resetPayload(account.email, token)))).status).toBe(
      503,
    );
    expect((await stored(account.id)).events).toEqual([]);
  });
  it('keeps unknown and OAuth-only forgot outcomes generic and never exposes the private mail plan publicly', async () => {
    const account = await seed('oauth@example.test', null);
    for (const email of ['absent@example.test', account.email]) {
      const reply = forgotPasswordReplySchema.parse(
        (await post('forgot-password', command('forgot-password', { email }))).body,
      );
      expect(reply.outcome).toBe('accepted');
      expect(reply).not.toHaveProperty('mailPlan');
    }
  });
  it('supersedes only UID receipts and leaves existing UUID links intact until reset', async () => {
    const account = await seed();
    const legacy = await legacyLink(account.email);
    const first = await uidLink(account.email);
    const second = await uidLink(account.email);
    expect(first).not.toBe(second);
    expect(
      (await fixture.ownerDatabase.select().from(verificationTokens)).some(
        (row) => row.identifier === 'password-reset:' + account.email,
      ),
    ).toBe(true);
    expectPrivateInvalid(await post('reset-password', command('reset-password', resetPayload(account.email, first))));
    expect((await post('reset-password', command('reset-password', resetPayload(account.email, second)))).status).toBe(
      200,
    );
    expectPrivateInvalid(await post('reset-password', command('reset-password', resetPayload(account.email, legacy))));
  });
  it('qualifies only the exact recovery ledger profile and denies direct partner invocation', async () => {
    expect((await qualify()).contract).toBe('private-recovery-v1');
    await expect(qualify('private-registration-evidence-v1')).rejects.toMatchObject({
      code: 'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    });
    await expect(fixture.writer`SELECT public.partner_revoke_user(${'not-a-user'})`).rejects.toMatchObject({
      code: '42501',
    });
    restoreGrants = true;
    await grantOwnedCredentialWriterCapabilities(fixture.owner, 'private-registration-evidence-v1');
    expect((await qualify('private-registration-evidence-v1')).contract).toBe('private-registration-evidence-v1');
    await expect(fixture.writer`SELECT * FROM public.auth_pre_enforcement_password_reset_events`).rejects.toMatchObject(
      { code: '42501' },
    );
  });
  it('rejects an extra column UPDATE on the immutable ledger', async () => {
    restoreGrants = true;
    await fixture.owner`GRANT UPDATE(recorded_at) ON public.auth_pre_enforcement_password_reset_events TO boardsesh_identity_writer`;
    await expect(qualify()).rejects.toMatchObject({ code: 'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT' });
  });
  it.each(['evidence', 'ledger', 'refresh'])(
    'rolls back actual partner trigger plus every reset write after a later %s fault',
    async (fault) => {
      vi.stubEnv('AUTH_PASSWORD_CHANGE_EVIDENCE_MODE', 'on');
      const account = await seed();
      const sibling = await seed('sibling@example.test');
      const token = await legacyLink(account.email);
      const partner = await withFixtureIo(async () => attachPartnerState(account.id, await createApp(sibling.id)));
      await fixture.ownerDatabase.insert(mobileRefreshTokens).values([
        { userId: account.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) },
        { userId: sibling.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) },
      ]);
      await getCredentialDatabase('private-recovery-v1');
      const before = await stored(account.id);
      if (fault !== 'ledger') restoreGrants = true;
      if (fault === 'ledger')
        await fixture.owner`ALTER TABLE public.auth_pre_enforcement_password_reset_events ADD CONSTRAINT owned_recovery_fault CHECK(operation_id IS NULL) NOT VALID`;
      else if (fault === 'evidence')
        await fixture.owner`REVOKE INSERT ON public.auth_password_change_evidence FROM boardsesh_identity_writer`;
      else await fixture.owner`REVOKE UPDATE ON public.mobile_refresh_tokens FROM boardsesh_identity_writer`;
      const input = command('reset-password', resetPayload(account.email, token)) as ResetPasswordCommand;
      try {
        let observed: unknown;
        try {
          await consumeRecoveryBeforeEnforcement(fixture.database, input);
        } catch (error) {
          observed = error;
        }
        expect(getPostgresErrorCode(observed)).toBe(fault === 'ledger' ? '23514' : '42501');
        expect((await post('reset-password', input)).status).toBe(503);
        const after = await stored(account.id);
        expect(after.credential.passwordHash).toBe(before.credential.passwordHash);
        expect(after.cutoff).toBeUndefined();
        expect(after.events).toEqual([]);
        expect(await fixture.ownerDatabase.select().from(authPasswordChangeEvidence)).toEqual([]);
        expect(countsOf(await withFixtureIo(() => readPartnerState(partner)))).toEqual(INTACT_COUNTS);
        expect(
          (await fixture.ownerDatabase.select().from(mobileRefreshTokens)).every((row) => row.revokedAt === null),
        ).toBe(true);
        expect(
          (await fixture.ownerDatabase.select().from(verificationTokens)).filter(
            (row) => row.identifier === 'password-reset:' + account.email,
          ),
        ).toHaveLength(1);
      } finally {
        if (fault === 'ledger')
          await fixture.owner`ALTER TABLE public.auth_pre_enforcement_password_reset_events DROP CONSTRAINT owned_recovery_fault`;
      }
    },
  );
  it('revokes actual partner state and every current refresh row for only the reset UID', async () => {
    const account = await seed();
    const sibling = await seed('sibling@example.test');
    const token = await legacyLink(account.email);
    const partner = await withFixtureIo(async () => attachPartnerState(account.id, await createApp(sibling.id)));
    await fixture.ownerDatabase.insert(mobileRefreshTokens).values([
      { userId: account.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) },
      { userId: account.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) },
      { userId: sibling.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) },
    ]);
    expect((await post('reset-password', command('reset-password', resetPayload(account.email, token)))).status).toBe(
      200,
    );
    expect(countsOf(await withFixtureIo(() => readPartnerState(partner)))).toEqual(REVOKED_COUNTS);
    const refresh = await fixture.ownerDatabase.select().from(mobileRefreshTokens);
    expect(refresh.filter((row) => row.userId === account.id).every((row) => row.revokedAt !== null)).toBe(true);
    expect(refresh.find((row) => row.userId === sibling.id)?.revokedAt).toBeNull();
  });
  it('allows exactly one concurrent UUID consume and one generation/event', async () => {
    const account = await seed();
    const token = await legacyLink(account.email);
    const results = await Promise.all(
      [1, 2].map(() => post('reset-password', command('reset-password', resetPayload(account.email, token)))),
    );
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(
      results
        .map((result) => resetPasswordReplySchema.parse(result.body).outcome)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(['invalid_or_expired', 'reset']);
    const changed = await stored(account.id);
    expect(changed.cutoff.generation).toBe(1);
    expect(changed.events).toHaveLength(1);
  });
  it.each(['hash', 'generation', 'cohort', 'context'] as const)(
    'refuses a fixture %s change after real bcrypt without claiming or resetting',
    async (change) => {
      const account = await seed();
      const token = await legacyLink(account.email);
      hooks.afterHash = async () => {
        hooks.afterHash = undefined;
        if (change === 'hash')
          await fixture.ownerDatabase
            .update(userCredentials)
            .set({ passwordHash: await hash('fixture-other-password', 4) })
            .where(eq(userCredentials.userId, account.id));
        if (change === 'generation')
          await fixture.ownerDatabase
            .insert(authSubjectCutoffs)
            .values({ userId: account.id, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
        if (change === 'cohort') await seed(account.email, null);
        if (change === 'context')
          await fixture.ownerDatabase.transaction((transaction) =>
            prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
          );
      };
      const result = await post('reset-password', command('reset-password', resetPayload(account.email, token)));
      if (change === 'cohort') expectPrivateInvalid(result);
      else expectUnavailable(result);
      expect((await stored(account.id)).events).toEqual([]);
      expect(
        (await fixture.ownerDatabase.select().from(verificationTokens)).some(
          (row) => row.token === createHash('sha256').update(token).digest('hex'),
        ),
      ).toBe(true);
    },
  );
  it.each(['deadline', 'hash', 'cohort'] as const)(
    'separately rereads %s after an observed user-lock wait',
    async (change) => {
      const account = await seed();
      const token = await legacyLink(account.email);
      const held = latch();
      const released = latch();
      let mutation: Promise<unknown> | undefined;
      hooks.afterHash = async () => {
        hooks.afterHash = undefined;
        mutation = fixture.ownerDatabase.transaction(async (transaction) => {
          await transaction.select().from(users).where(eq(users.id, account.id)).for('update');
          held.release();
          await released.promise;
          if (change === 'deadline')
            await transaction.execute(
              sql`UPDATE public."verificationTokens" SET expires=(clock_timestamp() AT TIME ZONE 'UTC')-interval '1 second' WHERE identifier=${'password-reset:' + account.email}`,
            );
          if (change === 'hash')
            await transaction
              .update(userCredentials)
              .set({ passwordHash: await hash('fixture-other-password', 4) })
              .where(eq(userCredentials.userId, account.id));
          if (change === 'cohort')
            await transaction
              .insert(users)
              .values({ id: randomUUID(), email: account.email, createdAt: new Date('2020-01-01') });
        });
        await held.promise;
      };
      const pending = post('reset-password', command('reset-password', resetPayload(account.email, token)));
      await held.promise;
      try {
        await waitFor(async () => {
          const [state] = await admin<
            { waiting: boolean }[]
          >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=${copyName} AND wait_event_type='Lock' AND query ILIKE '%for update%') AS waiting`;
          return state.waiting;
        });
      } finally {
        released.release();
      }
      await mutation;
      const result = await pending;
      if (change === 'hash') expectUnavailable(result);
      else expectPrivateInvalid(result);
      await assertUnconsumed(account.id, token);
    },
  );
  it('does not extend or round a deadline that actually expires while bcrypt is held', async () => {
    const account = await seed();
    const token = await legacyLink(account.email);
    await fixture.owner`UPDATE public."verificationTokens" SET expires=(clock_timestamp() AT TIME ZONE 'UTC')+interval '2.000123 seconds' WHERE identifier=${'password-reset:' + account.email}`;
    const [before] = await fixture.owner<
      { deadline: string }[]
    >`SELECT expires::text AS deadline FROM public."verificationTokens" WHERE identifier=${'password-reset:' + account.email}`;
    hooks.afterHash = async () => {
      hooks.afterHash = undefined;
      await waitFor(async () => {
        const [state] = await fixture.owner<
          { expired: boolean }[]
        >`SELECT expires<=(clock_timestamp() AT TIME ZONE 'UTC') AS expired FROM public."verificationTokens" WHERE identifier=${'password-reset:' + account.email}`;
        return state.expired;
      }, 3500);
    };
    expectPrivateInvalid(await post('reset-password', command('reset-password', resetPayload(account.email, token))));
    const [after] = await fixture.owner<
      { deadline: string }[]
    >`SELECT expires::text AS deadline FROM public."verificationTokens" WHERE identifier=${'password-reset:' + account.email}`;
    expect(after).toEqual(before);
    await assertUnconsumed(account.id, token);
  });
  it.each(['uuid', 'uid'] as const)(
    'commits exactly one %s consume when both real hashes complete before either final transaction',
    async (kind) => {
      const account = await seed();
      const token = kind === 'uuid' ? await legacyLink(account.email) : await uidLink(account.email);
      guards = createRecoveryCommandGuards({ redis: () => null, concurrency: 2, maxWaiting: 0 });
      const both = latch();
      let hashed = 0;
      hooks.afterHash = async () => {
        hashed += 1;
        if (hashed === 2) both.release();
        await both.promise;
      };
      const results = await Promise.all(
        [0, 1].map(() => post('reset-password', command('reset-password', resetPayload(account.email, token)))),
      );
      expect(hashed).toBe(2);
      expect(results.map((result) => result.status).sort((left, right) => left - right)).toEqual([200, 200]);
      expect(results.filter((result) => result.body.outcome === 'reset')).toHaveLength(1);
      expect(results.filter((result) => result.body.outcome === 'invalid_or_expired')).toHaveLength(1);
      expect((await stored(account.id)).cutoff.generation).toBe(1);
      expect((await stored(account.id)).events).toHaveLength(1);
    },
  );
  it('keeps both actual credential-pool waits in custody after the HTTP deadline and writes no late claim', async () => {
    const account = await seed();
    const token = await legacyLink(account.email);
    const credentials = await getCredentialDatabase('private-recovery-v1');
    const held = latch(),
      released = latch();
    let acquired = 0;
    const holders = [0, 1].map(() =>
      credentials.transaction(async (transaction) => {
        await transaction.execute(sql`SELECT 1`);
        acquired += 1;
        if (acquired === 2) held.release();
        await released.promise;
      }),
    );
    await held.promise;
    guards = createRecoveryCommandGuards({ redis: () => null, maxWaiting: 0 });
    const gate = guards.work('reset-password', 'unattributed');
    const started = performance.now();
    try {
      expectUnavailable(await post('reset-password', command('reset-password', resetPayload(account.email, token))));
      expect(performance.now() - started).toBeGreaterThanOrEqual(6800);
      expect(gate.isFull()).toBe(true);
      expectUnavailable(await post('reset-password', command('reset-password', resetPayload(account.email, token))));
    } finally {
      released.release();
      await Promise.all(holders);
    }
    await waitFor(() => !gate.isFull());
    await assertUnconsumed(account.id, token);
    expect(
      (await fixture.ownerDatabase.select().from(verificationTokens)).filter((row) =>
        row.identifier.startsWith('ba03-web-auth:'),
      ),
    ).toEqual([]);
  });
  it.each(['resolve', 'reject'] as const)(
    'keeps timed-out actual bcrypt %s in custody and never writes a late reset',
    async (settlement) => {
      const account = await seed();
      const token = await legacyLink(account.email);
      const hashed = latch(),
        released = latch();
      hooks.afterHash = async () => {
        hashed.release();
        await released.promise;
        if (settlement === 'reject') throw new Error('owned late hash rejection');
      };
      guards = createRecoveryCommandGuards({ redis: () => null, maxWaiting: 0 });
      const gate = guards.work('reset-password', 'unattributed');
      const pending = post('reset-password', command('reset-password', resetPayload(account.email, token)));
      await hashed.promise;
      try {
        expectUnavailable(await pending);
        expect(gate.isFull()).toBe(true);
      } finally {
        released.release();
      }
      await waitFor(() => !gate.isFull());
      await assertUnconsumed(account.id, token);
    },
  );
  it('removes a disconnected queued command without running its hash or mutation', async () => {
    const account = await seed();
    const token = await legacyLink(account.email);
    const held = latch(),
      released = latch();
    const gate = guards.work('reset-password', 'unattributed');
    const blocker = gate.run(async () => {
      held.release();
      await released.promise;
    });
    await held.promise;
    const abort = new AbortController();
    const pending = post(
      'reset-password',
      command('reset-password', resetPayload(account.email, token)),
      {},
      abort.signal,
    ).catch(() => undefined);
    await waitFor(() => gate.waiting() === 1);
    abort.abort();
    await pending;
    await waitFor(() => gate.waiting() === 0);
    released.release();
    await blocker;
    await assertUnconsumed(account.id, token);
  });
  it('holds an active disconnected reset until actual commit and treats its acknowledgement as uncertain', async () => {
    const account = await seed();
    const token = await legacyLink(account.email);
    const hashed = latch(),
      released = latch();
    hooks.afterHash = async () => {
      hashed.release();
      await released.promise;
    };
    guards = createRecoveryCommandGuards({ redis: () => null, maxWaiting: 0 });
    const gate = guards.work('reset-password', 'unattributed');
    const abort = new AbortController();
    const input = command('reset-password', resetPayload(account.email, token));
    const pending = post('reset-password', input, {}, abort.signal).catch(() => undefined);
    await hashed.promise;
    abort.abort();
    await pending;
    expect(gate.isFull()).toBe(true);
    released.release();
    await waitFor(() => !gate.isFull());
    expect((await stored(account.id)).events).toHaveLength(1);
    hooks.afterHash = undefined;
    const replay = await post('reset-password', input);
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ outcome: 'error', code: 'replayed', requestId: input.requestId });
    expectPrivateInvalid(await post('reset-password', command('reset-password', resetPayload(account.email, token))));
  });
  it.each(['check', 'default', 'trigger'] as const)(
    'refuses ledger %s drift during exact catalog qualification',
    async (drift) => {
      if (drift === 'check')
        await fixture.owner`ALTER TABLE public.auth_pre_enforcement_password_reset_events ADD CONSTRAINT owned_drift CHECK(generation>0)`;
      if (drift === 'default')
        await fixture.owner`ALTER TABLE public.auth_pre_enforcement_password_reset_events ALTER COLUMN recorded_at SET DEFAULT clock_timestamp()`;
      if (drift === 'trigger') {
        await fixture.owner.unsafe(
          'CREATE FUNCTION public.owned_recovery_drift() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
        );
        await fixture.owner.unsafe(
          'CREATE TRIGGER owned_recovery_drift BEFORE INSERT ON public.auth_pre_enforcement_password_reset_events FOR EACH ROW EXECUTE FUNCTION public.owned_recovery_drift()',
        );
      }
      try {
        await expect(qualify()).rejects.toMatchObject({
          code:
            drift === 'trigger'
              ? 'CREDENTIAL_WRITER_UNREVIEWED_TRIGGER_PATH'
              : 'CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE',
        });
      } finally {
        if (drift === 'check')
          await fixture.owner`ALTER TABLE public.auth_pre_enforcement_password_reset_events DROP CONSTRAINT owned_drift`;
        if (drift === 'default')
          await fixture.owner`ALTER TABLE public.auth_pre_enforcement_password_reset_events ALTER COLUMN recorded_at DROP DEFAULT`;
        if (drift === 'trigger') {
          await fixture.owner.unsafe(
            'DROP TRIGGER owned_recovery_drift ON public.auth_pre_enforcement_password_reset_events',
          );
          await fixture.owner.unsafe('DROP FUNCTION public.owned_recovery_drift()');
        }
      }
    },
  );
  it.each(['operation', 'version', 'session', 'stale'] as const)(
    'refuses wrong %s DTO before claiming a link',
    async (change) => {
      const account = await seed();
      const token = await legacyLink(account.email);
      const input: Record<string, unknown> = command('reset-password', resetPayload(account.email, token));
      if (change === 'operation') input.operation = 'forgot-password';
      if (change === 'version') input.protocolVersion = 1;
      if (change === 'session') input.webSession = {};
      if (change === 'stale') input.issuedAt = 0;
      const result = await post('reset-password', input);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: change === 'stale' ? 'expired_request' : 'invalid_request' });
      await assertUnconsumed(account.id, token);
    },
  );
  it.each([' owner@example.test ', '\u00a0OWNER@example.test\u00a0', 'OWNER@example.test'])(
    'refuses new UID issue/consume when another actual JS-normalized holder is %s',
    async (otherEmail) => {
      const account = await seed('owner@example.test');
      const token = await uidLink(account.email);
      const sibling = await seed(otherEmail, null);
      const issue = await post('forgot-password', command('forgot-password', { email: account.email }));
      expect(issue.status).toBe(200);
      expect(issue.body).toMatchObject({ outcome: 'accepted' });
      expect(issue.body).not.toHaveProperty('mailPlan');
      expectPrivateInvalid(await post('reset-password', command('reset-password', resetPayload(account.email, token))));
      expect((await stored(account.id)).events).toEqual([]);
      expect((await stored(sibling.id)).events).toEqual([]);
    },
  );
  it('rechecks actual JS-normalized UID membership after bcrypt without locking the new UID', async () => {
    const account = await seed('owner@example.test'),
      token = await uidLink(account.email);
    hooks.afterHash = async () => {
      hooks.afterHash = undefined;
      await seed('\u00a0OWNER@example.test\u00a0', null);
    };
    expectPrivateInvalid(await post('reset-password', command('reset-password', resetPayload(account.email, token))));
    expect((await stored(account.id)).events).toEqual([]);
  });
  it('preserves released UUID exact-first lookup in the presence of a stored whitespace spelling', async () => {
    const account = await seed('owner@example.test');
    await seed(' owner@example.test ', null);
    const token = await legacyLink(account.email);
    const result = await post('reset-password', command('reset-password', resetPayload(account.email, token)));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ outcome: 'reset' });
    expect((await stored(account.id)).events).toHaveLength(1);
  });
  it.each([
    'prepared-missing-projection',
    'prepared-missing-epoch',
    'absent-projection',
    'generation',
    'kind',
    'domains',
  ] as const)('rejects invalid immutable reset ledger shape %s in real PostgreSQL', async (change) => {
    const row = {
      operationId: randomUUID(),
      userId: randomUUID(),
      previousGeneration: 0,
      generation: 1,
      kind: 'password-reset',
      domains: ['first-party', 'partner'],
      contextPhase: 'absent',
      preparedProjectionId: null as string | null,
      preparedWriterEpoch: null as number | null,
      revokedThrough: new Date(),
      recordedAt: new Date(),
    };
    if (change === 'prepared-missing-projection') {
      row.contextPhase = 'prepared';
      row.preparedWriterEpoch = 1;
    }
    if (change === 'prepared-missing-epoch') {
      row.contextPhase = 'prepared';
      row.preparedProjectionId = randomUUID();
    }
    if (change === 'absent-projection') row.preparedProjectionId = randomUUID();
    if (change === 'generation') row.generation = 2;
    if (change === 'kind') row.kind = 'sign-in';
    if (change === 'domains') row.domains = ['first-party'];
    let failure: unknown;
    try {
      // Deliberately invalid enum/domain shapes cannot pass Drizzle's insert type.
      await fixture.owner`INSERT INTO public.auth_pre_enforcement_password_reset_events
        (operation_id,user_id,previous_generation,generation,kind,domains,context_phase,
          prepared_projection_id,prepared_writer_epoch,revoked_through,recorded_at)
        VALUES (${row.operationId},${row.userId},${row.previousGeneration},${row.generation},
          ${row.kind},${fixture.owner.array(row.domains)}::text[],${row.contextPhase},
          ${row.preparedProjectionId},${row.preparedWriterEpoch},${row.revokedThrough.toISOString()}::timestamptz,${row.recordedAt.toISOString()}::timestamptz)`;
    } catch (error) {
      failure = error;
    }
    expect(getPostgresErrorCode(failure)).toBe('23514');
  });
  it.each(['refresh-first', 'reset-first'] as const)(
    'serializes actual native refresh and default reset: %s',
    async (order) => {
      const account = await seed(),
        token = await legacyLink(account.email),
        rawRefresh = randomUUID();
      const parentHash = createHash('sha256').update(rawRefresh).digest('hex');
      const originalAge = new Date('2021-02-03T04:05:06Z'),
        sessionId = randomUUID();
      await fixture.ownerDatabase.insert(mobileRefreshTokens).values({
        userId: account.id,
        tokenHash: parentHash,
        expiresAt: new Date(Date.now() + 60_000),
        subjectGeneration: 0,
        nativeGeneration: 0,
        authenticatedAt: originalAge,
        sessionId,
      });
      const held = latch(),
        released = latch();
      const blocker = fixture.ownerDatabase.transaction(async (transaction) => {
        if (order === 'refresh-first')
          await transaction
            .select()
            .from(mobileRefreshTokens)
            .where(eq(mobileRefreshTokens.tokenHash, parentHash))
            .for('update');
        else
          await transaction.select().from(userCredentials).where(eq(userCredentials.userId, account.id)).for('update');
        held.release();
        await released.promise;
      });
      await held.promise;
      const waitQuery = async (fragment: string) =>
        waitFor(async () => {
          const [state] = await admin<
            { waiting: boolean }[]
          >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=${copyName} AND wait_event_type='Lock' AND query ILIKE ${'%' + fragment + '%'}) AS waiting`;
          return state.waiting;
        });
      const refresh = async () => {
        const response = await fetch(`${origin}/auth/native/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: rawRefresh }),
        });
        return { status: response.status, body: (await response.json()) as { jwt?: string; refreshToken?: string } };
      };
      let resetPending: ReturnType<typeof post>, refreshPending: ReturnType<typeof refresh>;
      try {
        if (order === 'refresh-first') {
          refreshPending = refresh();
          await waitQuery('update "mobile_refresh_tokens"');
          resetPending = post('reset-password', command('reset-password', resetPayload(account.email, token)));
          await waitQuery('"users"');
        } else {
          resetPending = post('reset-password', command('reset-password', resetPayload(account.email, token)));
          await waitQuery('"user_credentials"');
          refreshPending = refresh();
          await waitQuery('for key share');
        }
      } finally {
        released.release();
      }
      await blocker;
      const [resetResult, refreshResult] = await Promise.all([resetPending!, refreshPending!]);
      expect(resetResult.status).toBe(200);
      expect(resetResult.body).toMatchObject({ outcome: 'reset' });
      if (order === 'refresh-first') {
        expect(refreshResult.status).toBe(200);
        const claims = decodeJwt(refreshResult.body.jwt!);
        expect(claims).toMatchObject({
          sub: account.id,
          gen: 0,
          sid: sessionId,
          auth_time: Math.floor(originalAge.getTime() / 1000),
        });
        const childHash = createHash('sha256').update(refreshResult.body.refreshToken!).digest('hex');
        const [child] = await fixture.ownerDatabase
          .select()
          .from(mobileRefreshTokens)
          .where(eq(mobileRefreshTokens.tokenHash, childHash));
        expect(child.subjectGeneration).toBe(0);
        expect(child.authenticatedAt).toEqual(originalAge);
        expect(child.revokedAt).not.toBeNull();
      } else expect(refreshResult.status).toBe(401);
      const rows = await fixture.ownerDatabase
        .select()
        .from(mobileRefreshTokens)
        .where(eq(mobileRefreshTokens.userId, account.id));
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
      expect((await stored(account.id)).cutoff.generation).toBe(1);
      expect((await stored(account.id)).events).toHaveLength(1);
    },
  );
});
