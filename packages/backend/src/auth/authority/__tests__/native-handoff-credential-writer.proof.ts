import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { hash } from 'bcryptjs';
import { and, eq, sql } from 'drizzle-orm';
import { jwtVerify } from 'jose';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createDbOnPool, executeFirstRow } from '@boardsesh/db/client';
import { qualifyCredentialWriter, type CredentialWriterContract } from '@boardsesh/db/credential-writer-acl';
import {
  authBrowserBindings,
  authEmailProjection,
  authFirstPasswordChallenges,
  authSession,
  mobileRefreshTokens,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import {
  NATIVE_BROWSER_HANDOFF_COMMAND_PATH,
  nativeBrowserHandoffReplySchema,
} from '@boardsesh/auth-protocol/native-browser-handoff-v1';
import { createCredentialWriterEnvironment } from './fixtures/credential-writer-environment';
import { createProviderSecurityDriver } from './provider-security-fixture';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { captureIdentityAuthority, switchIdentityAuthority } from '../router';
import { closeCredentialDatabase, getCredentialDatabase } from '../../credential-database';
import { handleNativeBrowserHandoffIssue } from '../../../handlers/native-browser-handoff';
import { __resetNativeAuthStateForTests, handleNativeAuthExchange } from '../../../handlers/native-auth';
import { NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX } from '../native-browser-handoff';
import {
  deleteExpiredNativeBrowserHandoffClaims,
  runNativeBrowserHandoffMaintenance,
} from '../native-browser-handoff-maintenance';
import { runFirstPasswordPreparationMaintenance } from '../first-password-maintenance';

// A fallback to either shared content handle makes every positive control fail.
vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error('UNEXPECTED_NATIVE_HANDOFF_CONTENT_DATABASE');
      },
    },
  ),
  dbRead: new Proxy(
    {},
    {
      get: () => {
        throw new Error('UNEXPECTED_NATIVE_HANDOFF_CONTENT_DATABASE');
      },
    },
  ),
}));

const contract = 'private-native-handoff-v1' as const;
const rpcSecret = 'native-handoff-owned-private-rpc-secret-6975';
const sessionSecret = 'native-handoff-owned-original-source-secret-6975';
const handoffSecret = 'native-handoff-owned-distinct-capability-secret-6975';
const digest = (contents: string) => createHash('sha256').update(contents).digest('hex');
const tokenPairSchema = z
  .object({
    userId: z.string().min(1),
    jwt: z.string().min(1),
    refreshToken: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.iso.datetime(),
  })
  .strict();
type Authority = 'current-store' | 'better-auth';
type Kind = 'legacy-jwe' | 'canonical-token';
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let server: Server;
let origin: string;
let projectionId: string;
const qualification = () => ({
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
});
const qualify = (selected: CredentialWriterContract = contract) =>
  qualifyCredentialWriter(environment.writer, {
    expectedRole: 'boardsesh_identity_writer',
    expectedDatabase: environment.databaseName,
    contract: selected,
  });

async function source(selected: Authority, kind: Kind, unknownAge = false) {
  await environment.ownerDatabase.transaction(async (transaction) => {
    const receipt = await captureIdentityAuthority(transaction, qualification());
    if (receipt.authority !== selected)
      await switchIdentityAuthority(transaction, {
        projectionId,
        epoch: receipt.epoch,
        from: receipt.authority,
        to: selected,
      });
  });
  const driver = await createProviderSecurityDriver({
    database: environment.database,
    runtime: {
      qualification: qualification(),
      legacySecret: sessionSecret,
      methods: {
        configuredProviders: ['google', 'apple'],
        googleAudience: 'owned-google-client',
        googleReauthenticationEnabled: true,
      },
    },
  });
  return driver.actor(selected, kind, { password: false, unknownAge });
}
type Source = Awaited<ReturnType<typeof source>>;

async function issue(actor: Source) {
  const credential =
    actor.actor.kind === 'legacy-jwe'
      ? { kind: 'legacy-jwe' as const, credential: actor.actor.credential }
      : { kind: 'canonical-token' as const, token: actor.actor.credential };
  const response = await fetch(`${origin}${NATIVE_BROWSER_HANDOFF_COMMAND_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rpcSecret}` },
    body: JSON.stringify({
      nativeBrowserHandoffProtocolVersion: 1,
      operation: 'issue',
      requestId: randomUUID(),
      issuedAt: Date.now(),
      payload: {
        bindingToken: actor.actor.browserBindingToken,
        actor: { version: actor.actor.browserVersion, credential },
      },
    }),
  });
  const body: unknown = await response.json();
  expect(response.headers.get('set-cookie')).toBeNull();
  const reply = nativeBrowserHandoffReplySchema.parse(body);
  expect(response.status).toBe(200);
  if (reply.outcome !== 'admitted') throw new Error('Owned native handoff issuance refused');
  return reply;
}
async function exchange(token: string) {
  const response = await fetch(`${origin}/auth/native/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transferToken: token }),
  });
  const body: unknown = await response.json();
  expect(response.headers.get('set-cookie')).toBeNull();
  return { status: response.status, body };
}
const receiptRows = (token: string) =>
  environment.database
    .select()
    .from(verificationTokens)
    .where(
      and(
        eq(verificationTokens.identifier, `${NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX}${digest(token)}`),
        eq(verificationTokens.token, digest(token)),
      ),
    );
const nativeRows = (userId: string) =>
  environment.database.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, userId));
async function assertPair(result: Awaited<ReturnType<typeof exchange>>, actor: Source, capExpiresAt: string) {
  expect(result.status).toBe(200);
  const pair = tokenPairSchema.parse(result.body);
  expect(pair.userId).toBe(actor.userId);
  const { payload } = await jwtVerify(pair.jwt, new TextEncoder().encode(sessionSecret), {
    issuer: 'boardsesh',
    audience: 'boardsesh-mobile',
    algorithms: ['HS256'],
  });
  expect(payload).toMatchObject({ sub: actor.userId, gen: 0, ngen: 0 });
  if (actor.authenticatedAt) expect(payload.auth_time).toBe(actor.authenticatedAt.getTime() / 1000);
  else expect(payload).not.toHaveProperty('auth_time');
  const rows = await nativeRows(actor.userId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    tokenHash: digest(pair.refreshToken),
    sessionId: payload.sid,
    subjectGeneration: 0,
    nativeGeneration: 0,
    authenticatedAt: actor.authenticatedAt,
  });
  // The capability caps issuance, not the released native credential lifetime.
  expect(Date.parse(pair.expiresAt)).toBeGreaterThan(Date.parse(capExpiresAt));
  expect(rows[0]!.expiresAt.getTime()).toBeGreaterThan(Date.parse(capExpiresAt));
  return pair;
}

describe('private-native-handoff-v1 actual restricted LOGIN and native HTTP issuance', () => {
  beforeAll(async () => {
    environment = await createCredentialWriterEnvironment(contract);
    await environment.owner`GRANT USAGE ON SCHEMA public TO boardsesh_retired_runtime`;
    await environment.owner`REVOKE INSERT,UPDATE,DELETE ON users,"verificationTokens",mobile_refresh_tokens,auth_browser_bindings FROM boardsesh_retired_runtime`;
    await expect(environment.legacy`INSERT INTO mobile_refresh_tokens DEFAULT VALUES`).rejects.toMatchObject({
      code: '42501',
    });
    await environment.ownerDatabase.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(authEmailProjection)
        .where(eq(authEmailProjection.isCurrent, true));
      if (existing) {
        if (existing.phase !== 'enforced') throw new Error('Owned native proof requires enforced projection');
        projectionId = existing.projectionId;
      } else {
        projectionId = randomUUID();
        await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
        await transaction
          .update(authEmailProjection)
          .set({ phase: 'enforced' })
          .where(eq(authEmailProjection.projectionId, projectionId));
      }
    });
    server = createServer((request, response) => {
      const handler = request.url?.startsWith('/api/internal/auth/native-browser-handoff/')
        ? handleNativeBrowserHandoffIssue
        : handleNativeAuthExchange;
      void handler(request, response).catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned native proof failed to listen');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    // Each scenario is independent; the real per-peer limiter stays unchanged
    // within it, including the concurrent exchange/replay control.
    __resetNativeAuthStateForTests();
    for (const [name, contents] of Object.entries({
      DATABASE_URL: environment.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: contract,
      CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
      CURRENT_STORE_AUTH_RPC_SECRET: rpcSecret,
      NEXTAUTH_SECRET: sessionSecret,
      NATIVE_BROWSER_HANDOFF_SECRET: handoffSecret,
      BROWSER_DELEGATION_SECRET: 'native-proof-different-backend-delegation-key-6975',
      CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
      CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
      CURRENT_STORE_DELETED_EMAIL_KEY: 'native-proof-unrelated-deleted-email-key-6975',
      CURRENT_STORE_FIRST_PASSWORD_MODE: 'legacy',
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      AUTH_IDENTITY_MIRROR: 'off',
      DEBUG_SQL: 'false',
    }))
      vi.stubEnv(name, contents);
  });
  afterEach(async () => {
    await closeCredentialDatabase();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await closeCredentialDatabase();
    if (server)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await environment?.resetGrants();
    await environment?.close();
  });

  it('qualifies the exact new contract on the authenticated LOGIN and its transaction', async () => {
    const receipt = await qualify();
    expect(receipt.contract).toBe(contract);
    await environment.writer.begin(async (transaction) => {
      expect(
        await qualifyCredentialWriter(transaction, {
          expectedRole: 'boardsesh_identity_writer',
          expectedDatabase: environment.databaseName,
          contract,
        }),
      ).toEqual(receipt);
      const [identity] = await transaction`SELECT current_user AS role,session_user AS login`;
      expect(identity).toEqual({ role: 'boardsesh_identity_writer', login: 'boardsesh_identity_writer' });
    });
  });
  it('keeps profile4 strict, requires native INSERT, and permits an exact grant rollback', async () => {
    await expect(qualify('private-first-password-v1')).rejects.toMatchObject({
      code: 'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    });
    await environment.owner`REVOKE INSERT ON mobile_refresh_tokens FROM boardsesh_identity_writer`;
    try {
      await expect(environment.writer`INSERT INTO mobile_refresh_tokens DEFAULT VALUES`).rejects.toMatchObject({
        code: '42501',
      });
      expect((await qualify('private-first-password-v1')).contract).toBe('private-first-password-v1');
      await expect(qualify()).rejects.toMatchObject({ code: 'CREDENTIAL_WRITER_REQUIRED_GRANT_MISSING' });
    } finally {
      await environment.owner`GRANT INSERT ON mobile_refresh_tokens TO boardsesh_identity_writer`;
    }
    expect((await qualify()).contract).toBe(contract);
  });
  it('does not add native or account DELETE privileges', async () => {
    for (const statement of [
      'DELETE FROM mobile_refresh_tokens WHERE false',
      'DELETE FROM users WHERE false',
      'TRUNCATE mobile_refresh_tokens',
    ])
      await expect(environment.writer.unsafe(statement)).rejects.toMatchObject({ code: '42501' });
    expect((await qualify()).contract).toBe(contract);
  });
  it('shares one qualified physical database across all five reviewed capabilities', async () => {
    const database = await getCredentialDatabase(contract);
    for (const capability of [
      'private-web-v1',
      'private-browser-v1',
      'private-provider-v1',
      'private-first-password-v1',
      contract,
    ] as const)
      expect(await getCredentialDatabase(capability)).toBe(database);
    const identity = await executeFirstRow<{ role: string; login: string; name: string }>(
      database,
      sql`SELECT current_user AS role,session_user AS login,current_database() AS name`,
    );
    expect(identity).toEqual({
      role: 'boardsesh_identity_writer',
      login: 'boardsesh_identity_writer',
      name: environment.databaseName,
    });
  });
  for (const selected of ['current-store', 'better-auth'] as const)
    for (const kind of ['legacy-jwe', 'canonical-token'] as const)
      it(`${selected}/${kind}: default private issuer and native HTTP exchange preserve actual source and spend once`, async () => {
        const actor = await source(selected, kind);
        const bindingId = digest(actor.actor.browserBindingToken);
        const before = await environment.database
          .select()
          .from(authBrowserBindings)
          .where(eq(authBrowserBindings.id, bindingId));
        const issued = await issue(actor);
        await assertPair(await exchange(issued.token), actor, issued.expiresAt);
        expect(
          await environment.database.select().from(authBrowserBindings).where(eq(authBrowserBindings.id, bindingId)),
        ).toEqual(before);
        const claimed = await receiptRows(issued.token);
        expect(claimed).toHaveLength(1);
        expect(claimed[0]).toMatchObject({ token: digest(issued.token), expires: new Date(issued.expiresAt) });
        const replay = await exchange(issued.token);
        expect(replay.status).toBe(409);
        expect(replay.body).not.toHaveProperty('jwt');
        expect(replay.body).not.toHaveProperty('refreshToken');
        expect(await nativeRows(actor.userId)).toHaveLength(1);
      });
  it.each(['legacy-jwe', 'canonical-token'] as const)(
    '%s: unknown original authentication age remains unknown',
    async (kind) => {
      const actor = await source('better-auth', kind, true);
      const issued = await issue(actor);
      await assertPair(await exchange(issued.token), actor, issued.expiresAt);
    },
  );
  it('concurrent exchanges create one receipt and one actual native row', async () => {
    const actor = await source('better-auth', 'canonical-token');
    const issued = await issue(actor);
    const replies = await Promise.all([exchange(issued.token), exchange(issued.token), exchange(issued.token)]);
    expect(replies.map((reply) => reply.status).sort((left, right) => left - right)).toEqual([200, 409, 409]);
    expect(await receiptRows(issued.token)).toHaveLength(1);
    expect(await nativeRows(actor.userId)).toHaveLength(1);
  });
  it('a late native INSERT denial rolls back the receipt and leaves the same capability retryable', async () => {
    const actor = await source('current-store', 'canonical-token');
    const issued = await issue(actor); // Also establishes the actual qualified cached pool.
    await environment.owner`REVOKE INSERT ON mobile_refresh_tokens FROM boardsesh_identity_writer`;
    try {
      const refused = await exchange(issued.token);
      expect(refused.status).toBe(503);
      expect(refused.body).not.toHaveProperty('jwt');
      expect(await receiptRows(issued.token)).toEqual([]);
      expect(await nativeRows(actor.userId)).toEqual([]);
    } finally {
      await environment.owner`GRANT INSERT ON mobile_refresh_tokens TO boardsesh_identity_writer`;
    }
    await assertPair(await exchange(issued.token), actor, issued.expiresAt);
  });
  it('the real AFTER INSERT wait loses the database deadline and rolls back both writes on the actual writer', async () => {
    const actor = await source('better-auth', 'canonical-token');
    // Qualify before installing the deliberate post-qualification SQL fault.
    // This trigger is never part of an accepted catalog or normal grant plan.
    await getCredentialDatabase(contract);
    const holder = postgres(process.env.CREDENTIAL_WRITER_PROOF_DATABASE_URL!, { max: 1, onnotice: () => undefined });
    const lockKey = Number.parseInt(randomBytes(3).toString('hex'), 16) + 100_000;
    let locked = false;
    let pending: Promise<Awaited<ReturnType<typeof exchange>>> | undefined;
    let clock: { mockRestore(): void } | undefined;
    try {
      await holder`SELECT pg_advisory_lock(${lockKey})`;
      locked = true;
      const uid = actor.userId.replaceAll("'", "''");
      await environment.owner.unsafe(`
        CREATE FUNCTION public.epic6975_native_handoff_hold() RETURNS trigger LANGUAGE plpgsql AS $proof$
        BEGIN
          IF NEW.user_id='${uid}' THEN PERFORM pg_advisory_xact_lock(${lockKey}); END IF;
          RETURN NEW;
        END $proof$;
        CREATE TRIGGER epic6975_native_handoff_hold AFTER INSERT ON public.mobile_refresh_tokens
          FOR EACH ROW EXECUTE FUNCTION public.epic6975_native_handoff_hold();
      `);
      const [clockRow] = await environment.owner<{ now: Date | string }[]>`SELECT clock_timestamp() AS now`;
      const expiresAt = new Date(new Date(clockRow!.now).getTime() + 1500);
      await environment.ownerDatabase.update(authSession).set({ expiresAt }).where(eq(authSession.id, actor.sid));
      await environment.ownerDatabase
        .update(authBrowserBindings)
        .set({ credentialExpiresAt: expiresAt })
        .where(eq(authBrowserBindings.id, digest(actor.actor.browserBindingToken)));
      const issued = await issue(actor);
      // Keep the issuer's existing JS-clock check live while the PRIMARY clock
      // expires. Only the final transaction fence can reject after INSERT.
      clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      pending = exchange(issued.token);
      void pending.catch(() => {});
      let observed = false;
      const waitStarted = performance.now();
      while (performance.now() - waitStarted < 2500) {
        const [blocked] = await environment.owner<{ present: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_locks locked JOIN pg_stat_activity activity ON activity.pid=locked.pid
            WHERE locked.locktype='advisory' AND locked.objid::bigint=${lockKey} AND NOT locked.granted
              AND activity.usename='boardsesh_identity_writer') AS present`;
        if (blocked!.present) {
          observed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observed).toBe(true);
      for (;;) {
        const [deadline] = await environment.owner<{ expired: boolean }[]>`
          SELECT clock_timestamp() >= ${issued.expiresAt}::timestamptz AS expired`;
        if (deadline!.expired) break;
        if (performance.now() - waitStarted >= 3000) throw new Error('Owned database deadline did not advance');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await holder`SELECT pg_advisory_unlock(${lockKey})`;
      locked = false;
      const refused = await pending;
      expect(refused.status).toBe(401);
      expect(refused.body).not.toHaveProperty('jwt');
      expect(await receiptRows(issued.token)).toEqual([]);
      expect(await nativeRows(actor.userId)).toEqual([]);
    } finally {
      clock?.mockRestore();
      if (locked) await holder`SELECT pg_advisory_unlock(${lockKey})`;
      await pending?.catch(() => {});
      await environment.owner.unsafe(
        'DROP TRIGGER IF EXISTS epic6975_native_handoff_hold ON public.mobile_refresh_tokens; DROP FUNCTION IF EXISTS public.epic6975_native_handoff_hold()',
      );
      await holder.end();
    }
    expect((await qualify()).contract).toBe(contract);
  });
  it('old-profile configuration refuses native issuance without spending a valid capability', async () => {
    const actor = await source('current-store', 'canonical-token');
    const issued = await issue(actor);
    await closeCredentialDatabase();
    vi.stubEnv('AUTH_IDENTITY_DATABASE_CONTRACT', 'private-first-password-v1');
    expect((await exchange(issued.token)).status).toBe(503);
    expect(await receiptRows(issued.token)).toEqual([]);
    expect(await nativeRows(actor.userId)).toEqual([]);
    vi.stubEnv('AUTH_IDENTITY_DATABASE_CONTRACT', contract);
    await assertPair(await exchange(issued.token), actor, issued.expiresAt);
  });
  it('qualified cleanup works during mode rollback and preserves active and unrelated receipts despite host-clock skew', async () => {
    const actor = await source('better-auth', 'canonical-token');
    const issued = await issue(actor);
    await assertPair(await exchange(issued.token), actor, issued.expiresAt);
    const clockRow = (await environment.owner<{ now: Date | string }[]>`SELECT clock_timestamp() AS now`)[0]!;
    const now = new Date(clockRow.now);
    const expired = randomBytes(32).toString('hex');
    const active = randomBytes(32).toString('hex');
    const unrelated = randomBytes(32).toString('hex');
    await environment.database.insert(verificationTokens).values([
      {
        identifier: `${NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX}${expired}`,
        token: expired,
        expires: new Date(now.getTime() - 1000),
      },
      {
        identifier: `${NATIVE_BROWSER_HANDOFF_RECEIPT_PREFIX}${active}`,
        token: active,
        expires: new Date(now.getTime() + 60_000),
      },
      { identifier: `unrelated-native-proof:${unrelated}`, token: unrelated, expires: new Date(now.getTime() - 1000) },
    ]);
    const database = await getCredentialDatabase(contract);
    vi.stubEnv('CURRENT_STORE_BROWSER_BINDING_MODE', 'legacy');
    // Move both Date.now AND new Date(), keeping network/SQL timers real.
    // A host-clock cleanup mutant must erase this live spent capability.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now.getTime() + 86_400_000);
    try {
      // Earlier successful reruns can leave other genuinely expired receipts.
      expect(await runNativeBrowserHandoffMaintenance()).toBeGreaterThanOrEqual(1);
      expect(await getCredentialDatabase('private-web-v1')).toBe(database);
    } finally {
      vi.useRealTimers();
    }
    // Check the security consequence first: deleting a live spent receipt
    // would make this exact still-valid capability issue a second native pair.
    vi.stubEnv('CURRENT_STORE_BROWSER_BINDING_MODE', 'backend-staging');
    expect((await exchange(issued.token)).status).toBe(409);
    expect(await nativeRows(actor.userId)).toHaveLength(1);
    expect(await receiptRows(issued.token)).toHaveLength(1);
    expect(
      await environment.database.select().from(verificationTokens).where(eq(verificationTokens.token, expired)),
    ).toEqual([]);
    expect(
      await environment.database.select().from(verificationTokens).where(eq(verificationTokens.token, active)),
    ).toHaveLength(1);
    expect(
      await environment.database.select().from(verificationTokens).where(eq(verificationTokens.token, unrelated)),
    ).toHaveLength(1);
  });
  it('a non-UTC authenticated connection cannot erase a still-redeemable spent receipt', async () => {
    const actor = await source('better-auth', 'canonical-token');
    const issued = await issue(actor);
    await assertPair(await exchange(issued.token), actor, issued.expiresAt);
    const zoned = postgres(environment.writerUrl, {
      max: 1,
      onnotice: () => undefined,
      connection: { TimeZone: 'Pacific/Kiritimati' },
    });
    try {
      const [setting] = await zoned`SELECT current_setting('TimeZone') AS zone,current_user AS role`;
      expect(setting).toEqual({ zone: 'Pacific/Kiritimati', role: 'boardsesh_identity_writer' });
      expect(
        (
          await qualifyCredentialWriter(zoned, {
            expectedRole: 'boardsesh_identity_writer',
            expectedDatabase: environment.databaseName,
            contract,
          })
        ).contract,
      ).toBe(contract);
      await deleteExpiredNativeBrowserHandoffClaims(createDbOnPool(zoned, { logger: false }));
      expect(await receiptRows(issued.token)).toHaveLength(1);
      expect((await exchange(issued.token)).status).toBe(409);
      expect(await nativeRows(actor.userId)).toHaveLength(1);
    } finally {
      await zoned.end();
    }
  });
  it('profile5 retains first-password secret scrubbing while the feature is rolled back', async () => {
    const userId = randomUUID();
    const now = new Date();
    const issuedAt = new Date(now.getTime() - 360_000);
    const challengeHash = randomBytes(32).toString('hex');
    const randomDigest = () => randomBytes(32).toString('hex');
    const authority = await environment.database.transaction((transaction) =>
      captureIdentityAuthority(transaction, qualification()),
    );
    await environment.database.insert(users).values({ id: userId, email: `${userId}@example.invalid` });
    await environment.database.insert(authFirstPasswordChallenges).values({
      challengeHash,
      purpose: 'first-password',
      operationId: randomUUID(),
      userId,
      emailBindingHash: randomDigest(),
      confirmationTokenHash: randomDigest(),
      recoveryTokenHash: randomDigest(),
      actorCredentialKind: 'canonical-token',
      actorCredentialHash: randomDigest(),
      actorSessionId: randomUUID(),
      actorGeneration: 0,
      actorAuthenticatedAt: null,
      actorLinkGuarded: false,
      actorRequiresAccountCutoff: false,
      actorExpiresAt: new Date(now.getTime() + 3_600_000),
      browserBindingHash: randomDigest(),
      browserVersion: 1,
      browserIntentHash: randomDigest(),
      browserBindingExpiresAt: new Date(now.getTime() + 3_600_000),
      projectionId,
      normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      writerAuthority: authority.authority,
      writerEpoch: authority.epoch,
      phase: 'prepared',
      issuedAt,
      expiresAt: new Date(now.getTime() - 60_000),
      pendingPasswordHash: await hash(' abandoned native-profile first password ', 4),
      preparedAt: new Date(issuedAt.getTime() + 1000),
      preparationTokenHash: randomDigest(),
      proposedCredentialHash: randomDigest(),
    });
    const database = await getCredentialDatabase(contract);
    expect(await runFirstPasswordPreparationMaintenance()).toMatchObject({ scrubbed: 1 });
    expect(await getCredentialDatabase('private-first-password-v1')).toBe(database);
    const [challenge] = await environment.database
      .select()
      .from(authFirstPasswordChallenges)
      .where(eq(authFirstPasswordChallenges.challengeHash, challengeHash));
    expect(challenge).toMatchObject({ phase: 'terminal', pendingPasswordHash: null });
    await expect(environment.writer`DELETE FROM auth_first_password_challenges WHERE false`).rejects.toMatchObject({
      code: '42501',
    });
  });
});
