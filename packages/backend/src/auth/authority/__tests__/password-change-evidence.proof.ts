import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { qualifyCredentialWriter } from '@boardsesh/db/credential-writer-acl';
import { mintDeviceToken } from '@boardsesh/auth-protocol/device-token';
import {
  authAccount,
  authEmailProjection,
  authPasswordChangeEvidence,
  mobileRefreshTokens,
  userCredentials,
  users,
} from '@boardsesh/db/schema/auth';
import { createCredentialWriterEnvironment } from './fixtures/credential-writer-environment';
import { bindIdentityAuthority, type IdentityPasswordSnapshot } from '../identity-authority';
import { captureIdentityAuthority, switchIdentityAuthority, type IdentityAuthorityName } from '../router';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { syncIdentity } from '../sync-identity';
import { mirrorAuthorityToCurrentStore } from '../reverse-identity';
import { recordIdentitySecurityMutation } from '../security-mutation';
import {
  passwordChangeEvidenceEnabled,
  passwordFingerprint,
  recordPasswordChangeEvidence,
} from '../../password-change-evidence';
import { readPasswordGuessAccounts } from '../../password-guess-windows';
import { createPasswordGuessLimiter, ACCOUNT_GUESS_LIMIT_ENFORCE_BLOCKERS } from '../../password-guess-limit';
import { credentialWriterContract } from '../../credential-database-configuration';
import { closeCredentialDatabase } from '../../credential-database';
import { handleNativeAuthRegister } from '../../../handlers/native-auth';
import { getPostgresErrorCode } from '../../../utils/postgres-errors';

vi.mock('../../../db/client', () => {
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_SHARED_CREDENTIAL_DATABASE');
      },
    },
  );
  return { db: forbidden, dbRead: forbidden };
});

const ORIGINAL = '$2b$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
const REPLACEMENT = '$2b$12$1avkJS6hZfQZqD0nMW0NLeZLgBtKkJNG9c9IeOlQl5QvwDTDVSihe';
let projectionId: string = randomUUID();
const qualification = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
};
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let server: Server;
let origin: string;
const qualify = (
  contract: 'private-password-evidence-v1' | 'private-browser-renewal-v1' = 'private-password-evidence-v1',
) =>
  qualifyCredentialWriter(environment.writer, {
    expectedRole: 'boardsesh_identity_writer',
    expectedDatabase: environment.databaseName,
    contract,
  });
async function selectAuthority(to: IdentityAuthorityName) {
  await environment.ownerDatabase.transaction(async (transaction) => {
    const [manifest] = await transaction
      .select()
      .from(authEmailProjection)
      .where(eq(authEmailProjection.isCurrent, true));
    if (manifest.writerAuthority !== to)
      await switchIdentityAuthority(transaction, {
        projectionId,
        epoch: manifest.writerEpoch,
        from: manifest.writerAuthority,
        to,
      });
  });
}
async function fixture(withPassword = true) {
  const userId = randomUUID();
  const email = `evidence-${userId}@example.invalid`;
  await environment.database.transaction(async (transaction) => {
    const identity = bindIdentityAuthority(transaction, await captureIdentityAuthority(transaction, qualification));
    await identity.createUser({ id: userId, email, name: 'Owned evidence' });
    if (withPassword) await identity.insertPassword(userId, ORIGINAL, 0);
  });
  return { userId, email };
}
const evidence = (userId: string) =>
  environment.ownerDatabase
    .select()
    .from(authPasswordChangeEvidence)
    .where(eq(authPasswordChangeEvidence.userId, userId));
const legacy = (userId: string) =>
  environment.ownerDatabase.select().from(userCredentials).where(eq(userCredentials.userId, userId));
async function replace(userId: string, replacement: string, expected?: IdentityPasswordSnapshot) {
  return environment.database.transaction(async (transaction) => {
    const identity = bindIdentityAuthority(transaction, await captureIdentityAuthority(transaction, qualification));
    const password = expected ?? (await identity.readPassword(userId));
    if (!password) throw new Error('Owned credential missing');
    return identity.replacePassword(password, replacement);
  });
}
async function databaseNow() {
  const [clock] = await environment.owner<
    { nowMs: number }[]
  >`SELECT extract(epoch FROM clock_timestamp())::float8 * 1000 AS "nowMs"`;
  return clock.nowMs;
}
async function observed(email: string) {
  return readPasswordGuessAccounts(environment.database, email, { deadlineMs: 5_000 });
}

describe('password-change evidence on the exact current credential LOGIN', () => {
  beforeAll(async () => {
    environment = await createCredentialWriterEnvironment('private-password-evidence-v1');
    await environment.ownerDatabase.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(authEmailProjection)
        .where(eq(authEmailProjection.isCurrent, true));
      if (existing) {
        if (existing.phase !== 'enforced') throw new Error('Owned evidence proof requires enforced manifest');
        projectionId = existing.projectionId;
        qualification.expectedProjectionId = projectionId;
      } else {
        await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
        await transaction.update(authEmailProjection).set({ phase: 'enforced' });
      }
    });
    server = createServer((request, response) => {
      void handleNativeAuthRegister(request, response).catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned native fixture failed to bind');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    vi.stubEnv('AUTH_PASSWORD_CHANGE_EVIDENCE_MODE', 'on');
    vi.stubEnv('AUTH_IDENTITY_DATABASE_CONTRACT', 'private-password-evidence-v1');
    vi.stubEnv('AUTH_IDENTITY_DATABASE_URL', environment.writerUrl);
    vi.stubEnv('DATABASE_URL', environment.legacyUrl);
    vi.stubEnv('NEXTAUTH_SECRET', 'owned-password-evidence-native-signing-secret-6975');
    vi.stubEnv('AUTH_IDENTITY_MIRROR', 'off');
    vi.stubEnv('CURRENT_STORE_NATIVE_REGISTRATION_MODE', 'legacy');
    vi.stubEnv('EMAIL_VERIFICATION_ENABLED', 'false');
    await environment.ownerDatabase.update(authEmailProjection).set({ phase: 'enforced' });
    await selectAuthority('current-store');
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await closeCredentialDatabase();
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await environment?.close();
  });

  it('qualifies only the new exact profile, with immutable evidence ownership and no default age', async () => {
    expect((await qualify()).contract).toBe('private-password-evidence-v1');
    await expect(qualify('private-browser-renewal-v1')).rejects.toMatchObject({
      code: 'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    });
    await environment.owner`GRANT UPDATE(user_id) ON auth_password_change_evidence TO boardsesh_identity_writer`;
    try {
      await expect(qualify()).rejects.toMatchObject({ code: 'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT' });
    } finally {
      await environment.owner`REVOKE UPDATE(user_id) ON auth_password_change_evidence FROM boardsesh_identity_writer`;
    }
    await environment.owner`ALTER TABLE auth_password_change_evidence ALTER COLUMN changed_at SET DEFAULT now()`;
    try {
      await expect(qualify()).rejects.toMatchObject({ code: 'CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE' });
    } finally {
      await environment.owner`ALTER TABLE auth_password_change_evidence ALTER COLUMN changed_at DROP DEFAULT`;
    }
    expect((await qualify()).contract).toBe('private-password-evidence-v1');
  });

  it('keeps default-off inert, rejects invalid mode/profile, and leaves enforcement blocked', async () => {
    expect(passwordChangeEvidenceEnabled({})).toBe(false);
    expect(passwordChangeEvidenceEnabled({ AUTH_PASSWORD_CHANGE_EVIDENCE_MODE: '' })).toBe(false);
    expect(() => passwordChangeEvidenceEnabled({ AUTH_PASSWORD_CHANGE_EVIDENCE_MODE: 'ON' })).toThrow(
      'AUTH_PASSWORD_CHANGE_EVIDENCE_MODE_INVALID',
    );
    expect(() =>
      credentialWriterContract({
        AUTH_PASSWORD_CHANGE_EVIDENCE_MODE: 'on',
        AUTH_IDENTITY_DATABASE_CONTRACT: 'private-browser-renewal-v1',
      }),
    ).toThrow('PASSWORD_CHANGE_EVIDENCE_CREDENTIAL_PROFILE_REQUIRED');
    expect(ACCOUNT_GUESS_LIMIT_ENFORCE_BLOCKERS).toContain('PASSWORD_CHANGE_TIME_IGNORES_AUTHORITY');
    vi.stubEnv('AUTH_PASSWORD_CHANGE_EVIDENCE_MODE', 'off');
    await expect(
      recordPasswordChangeEvidence({} as Parameters<typeof recordPasswordChangeEvidence>[0], 'unused', ORIGINAL),
    ).resolves.toBeUndefined();
  });

  for (const authority of ['current-store', 'better-auth'] as const) {
    it(`${authority} records insertion and replacement from the database clock, regardless of app Date`, async () => {
      await selectAuthority(authority);
      const before = await databaseNow();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2000-01-01T00:00:00Z'));
      const account = await fixture();
      const inserted = (await evidence(account.userId))[0];
      expect(inserted.passwordFingerprint).toBe(passwordFingerprint(ORIGINAL));
      expect(inserted.changedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(await replace(account.userId, REPLACEMENT)).toBe(true);
      const changed = (await evidence(account.userId))[0];
      expect(changed.passwordFingerprint).toBe(passwordFingerprint(REPLACEMENT));
      expect(changed.changedAt.getTime()).toBeGreaterThanOrEqual(inserted.changedAt.getTime());
      expect(changed.changedAt.getTime()).toBeLessThanOrEqual(await databaseNow());
      expect(await observed(account.email)).toEqual([{ userId: account.userId, passwordChangedAt: changed.changedAt }]);
    });

    it(`${authority} rolls password and evidence back on actual evidence CHECK and later SQL faults`, async () => {
      await selectAuthority(authority);
      const account = await fixture();
      const before = await evidence(account.userId);
      await environment.owner.unsafe(
        `ALTER TABLE auth_password_change_evidence ADD CONSTRAINT owned_evidence_reject CHECK (password_fingerprint <> '${passwordFingerprint(REPLACEMENT)}') NOT VALID`,
      );
      try {
        expect(getPostgresErrorCode(await replace(account.userId, REPLACEMENT).catch((error: unknown) => error))).toBe(
          '23514',
        );
      } finally {
        await environment.owner`ALTER TABLE auth_password_change_evidence DROP CONSTRAINT owned_evidence_reject`;
      }
      expect(await evidence(account.userId)).toEqual(before);
      const failure = await environment.database
        .transaction(async (transaction) => {
          const identity = bindIdentityAuthority(
            transaction,
            await captureIdentityAuthority(transaction, qualification),
          );
          const password = await identity.readPassword(account.userId);
          if (!password) throw new Error('Missing password');
          expect(await identity.replacePassword(password, REPLACEMENT)).toBe(true);
          await transaction.execute(sql`SELECT 1 / 0`);
        })
        .catch((error: unknown) => error);
      expect(getPostgresErrorCode(failure)).toBe('22012');
      expect(await evidence(account.userId)).toEqual(before);
      const password = await environment.database.transaction(async (transaction) =>
        bindIdentityAuthority(transaction, await captureIdentityAuthority(transaction, qualification)).readPassword(
          account.userId,
        ),
      );
      expect(password?.passwordHash).toBe(ORIGINAL);
    });
  }

  it('waits for a concurrent replacement, refuses the stale CAS, and keeps the winner evidence', async () => {
    const account = await fixture();
    const stale = { userId: account.userId, passwordHash: ORIGINAL, generation: 0 };
    let release!: () => void;
    let written!: () => void;
    const ready = new Promise<void>((resolve) => {
      written = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const winner = environment.database.transaction(async (transaction) => {
      const identity = bindIdentityAuthority(transaction, await captureIdentityAuthority(transaction, qualification));
      expect(await identity.replacePassword(stale, REPLACEMENT)).toBe(true);
      written();
      await barrier;
    });
    await ready;
    const loser = replace(account.userId, 'stale-loser-exact-hash', stale);
    try {
      await vi.waitFor(async () => {
        const [waiter] = await environment.owner<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='boardsesh_identity_writer' AND wait_event_type='Lock') AS waiting`;
        expect(waiter.waiting).toBe(true);
      });
    } finally {
      release();
    }
    await winner;
    expect(await loser).toBe(false);
    expect((await legacy(account.userId))[0].passwordHash).toBe(REPLACEMENT);
    expect((await evidence(account.userId))[0].passwordFingerprint).toBe(passwordFingerprint(REPLACEMENT));
  });

  it('does not fabricate age during imports, forward/reverse copies, or timestamp metadata writes', async () => {
    vi.stubEnv('AUTH_PASSWORD_CHANGE_EVIDENCE_MODE', 'off');
    const historical = await fixture();
    vi.stubEnv('AUTH_PASSWORD_CHANGE_EVIDENCE_MODE', 'on');
    await environment.database.transaction((transaction) =>
      syncIdentity(transaction, historical.userId, 'current-store-to-authority'),
    );
    expect(await evidence(historical.userId)).toEqual([]);
    expect(await observed(historical.email)).toEqual([{ userId: historical.userId, passwordChangedAt: null }]);
    const known = await fixture();
    const before = await evidence(known.userId);
    await environment.database.transaction((transaction) =>
      syncIdentity(transaction, known.userId, 'current-store-to-authority'),
    );
    await selectAuthority('better-auth');
    await environment.database.transaction((transaction) => mirrorAuthorityToCurrentStore(transaction, known.userId));
    await environment.database.transaction((transaction) =>
      mirrorAuthorityToCurrentStore(transaction, historical.userId),
    );
    await environment.ownerDatabase
      .update(authAccount)
      .set({ updatedAt: new Date('2030-01-01') })
      .where(eq(authAccount.userId, known.userId));
    expect(await evidence(known.userId)).toEqual(before);
    expect(await evidence(historical.userId)).toEqual([]);
    expect(await observed(known.email)).toEqual([{ userId: known.userId, passwordChangedAt: before[0].changedAt }]);
    await selectAuthority('current-store');
    expect(await evidence(known.userId)).toEqual(before);
  });

  for (const authority of ['current-store', 'better-auth'] as const)
    it(`${authority} provider insertion and security-generation advance preserve password evidence`, async () => {
      const account = await fixture();
      const before = await evidence(account.userId);
      await environment.database.transaction((transaction) =>
        syncIdentity(transaction, account.userId, 'current-store-to-authority'),
      );
      await selectAuthority(authority);
      await environment.database.transaction(async (transaction) => {
        const receipt = await captureIdentityAuthority(transaction, qualification);
        const identity = bindIdentityAuthority(transaction, receipt);
        await identity.insertProvider({ userId: account.userId, provider: 'google', subject: randomUUID() }, 0);
        const mutation = await recordIdentitySecurityMutation(
          transaction,
          {
            ...qualification,
            expectedWriterEpoch: receipt.epoch,
            userId: account.userId,
            expectedGeneration: 0,
            operationId: randomUUID(),
            kind: 'provider-link',
            domains: ['first-party', 'partner'],
          },
          receipt,
        );
        expect(mutation.cutoff.generation).toBe(1);
      });
      expect(await evidence(account.userId)).toEqual(before);
      expect(await observed(account.email)).toEqual([
        { userId: account.userId, passwordChangedAt: before[0].changedAt },
      ]);
    });

  it('selects only the authoritative hash and refuses mismatched, ambiguous and stale canonical evidence', async () => {
    const account = await fixture();
    const before = await evidence(account.userId);
    await environment.database.transaction((transaction) =>
      syncIdentity(transaction, account.userId, 'current-store-to-authority'),
    );
    await environment.ownerDatabase
      .update(authAccount)
      .set({ password: REPLACEMENT })
      .where(eq(authAccount.userId, account.userId));
    expect(await observed(account.email)).toEqual([{ userId: account.userId, passwordChangedAt: before[0].changedAt }]);
    await selectAuthority('better-auth');
    expect(await observed(account.email)).toEqual([{ userId: account.userId, passwordChangedAt: null }]);
    await environment.ownerDatabase
      .update(authAccount)
      .set({ password: ORIGINAL, sourceGeneration: 1 })
      .where(eq(authAccount.userId, account.userId));
    expect(await observed(account.email)).toEqual([{ userId: account.userId, passwordChangedAt: null }]);
    await environment.ownerDatabase
      .update(authAccount)
      .set({ sourceGeneration: 0 })
      .where(eq(authAccount.userId, account.userId));
    expect(await observed(account.email)).toEqual([{ userId: account.userId, passwordChangedAt: before[0].changedAt }]);
    await environment.ownerDatabase.insert(authAccount).values({
      id: randomUUID(),
      userId: account.userId,
      providerId: 'credential',
      accountId: randomUUID(),
      password: ORIGINAL,
      sourceGeneration: 0,
    });
    expect(await observed(account.email)).toEqual([{ userId: account.userId, passwordChangedAt: null }]);
  });

  it('bounds candidate users before crowded canonical rows under either authority', async () => {
    const crowded = await fixture();
    const sibling = await fixture();
    await environment.ownerDatabase.update(users).set({ email: crowded.email }).where(eq(users.id, sibling.userId));
    await environment.database.transaction(async (transaction) => {
      await syncIdentity(transaction, crowded.userId, 'current-store-to-authority');
      await syncIdentity(transaction, sibling.userId, 'current-store-to-authority');
    });
    await environment.ownerDatabase.insert(authAccount).values(
      Array.from({ length: 9 }, () => ({
        id: randomUUID(),
        userId: crowded.userId,
        providerId: 'credential',
        accountId: randomUUID(),
        password: ORIGINAL,
        sourceGeneration: 0,
      })),
    );
    const siblingEvidence = (await evidence(sibling.userId))[0];
    for (const authority of ['current-store', 'better-auth'] as const) {
      await selectAuthority(authority);
      const accounts = await observed(crowded.email);
      expect(accounts).toHaveLength(2);
      expect(accounts).toEqual(
        expect.arrayContaining([{ userId: sibling.userId, passwordChangedAt: siblingEvidence.changedAt }]),
      );
    }
  });

  it('refuses unsupported manifest phases even if external schema checks are missing', async () => {
    const account = await fixture();
    const definitions = await environment.owner<
      { name: string; definition: string }[]
    >`SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='auth_email_projection'::regclass AND conname IN ('auth_email_projection_phase','auth_email_projection_completion') ORDER BY conname`;
    for (const definition of definitions)
      await environment.owner.unsafe(`ALTER TABLE auth_email_projection DROP CONSTRAINT "${definition.name}"`);
    await environment.owner`UPDATE auth_email_projection SET phase='unsupported-phase' WHERE is_current`;
    try {
      expect(await observed(account.email)).toBe('unavailable');
    } finally {
      await environment.owner`UPDATE auth_email_projection SET phase='enforced' WHERE is_current`;
      for (const definition of definitions)
        await environment.owner.unsafe(
          `ALTER TABLE auth_email_projection ADD CONSTRAINT "${definition.name}" ${definition.definition}`,
        );
    }
  });

  it('keeps an uncaptured rollback write unknown and leaves evidence unchanged until a real captured write', async () => {
    const account = await fixture();
    const before = await evidence(account.userId);
    vi.stubEnv('AUTH_PASSWORD_CHANGE_EVIDENCE_MODE', 'off');
    expect(await replace(account.userId, REPLACEMENT)).toBe(true);
    vi.stubEnv('AUTH_PASSWORD_CHANGE_EVIDENCE_MODE', 'on');
    expect(await evidence(account.userId)).toEqual(before);
    expect(await observed(account.email)).toEqual([{ userId: account.userId, passwordChangedAt: null }]);
    expect(await replace(account.userId, 'later-captured-password-hash')).toBe(true);
    expect(await observed(account.email)).toEqual([
      { userId: account.userId, passwordChangedAt: (await evidence(account.userId))[0].changedAt },
    ]);
  });

  it('treats missing evidence, password absence and schema/read failure as unrecognised or unavailable', async () => {
    const absent = await fixture(false);
    expect(await observed(absent.email)).toEqual([{ userId: absent.userId, passwordChangedAt: null }]);
    const account = await fixture();
    await environment.owner`REVOKE SELECT ON auth_password_change_evidence FROM boardsesh_identity_writer`;
    try {
      expect(await observed(account.email)).toBe('unavailable');
    } finally {
      await environment.owner`GRANT SELECT ON auth_password_change_evidence TO boardsesh_identity_writer`;
    }
    await environment.owner`ALTER TABLE auth_email_projection DROP CONSTRAINT auth_email_projection_writer_authority`;
    await environment.owner`UPDATE auth_email_projection SET writer_authority='unknown' WHERE is_current`;
    try {
      expect(await observed(account.email)).toBe('unavailable');
    } finally {
      await environment.owner`UPDATE auth_email_projection SET writer_authority='current-store' WHERE is_current`;
      await environment.owner`ALTER TABLE auth_email_projection ADD CONSTRAINT auth_email_projection_writer_authority CHECK (writer_authority IN ('current-store','better-auth'))`;
    }
    expect((await qualify()).contract).toBe('private-password-evidence-v1');
  });

  it('preserves the inclusive five-second device-token tolerance and refuses one second older', async () => {
    const account = await fixture();
    const changedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    await environment.ownerDatabase
      .update(authPasswordChangeEvidence)
      .set({ changedAt })
      .where(eq(authPasswordChangeEvidence.userId, account.userId));
    const secret = randomBytes(32).toString('hex');
    const guard = createPasswordGuessLimiter({
      mode: 'enforce',
      store: () => environment.ownerDatabase,
      deadlineMs: 5_000,
      environment: {
        AUTH_DEVICE_TOKEN_SECRET: secret,
        AUTH_ACCOUNT_GUESS_LIMIT_EMAIL_KEY: randomBytes(32).toString('hex'),
      },
    });
    for (let index = 0; index < 10; index++) {
      const attempt = await guard.admit({ email: account.email });
      if (attempt.outcome !== 'proceed') throw new Error('Owned counter unexpectedly refused');
      await attempt.settle('rejected');
    }
    const token = async (offset: number) =>
      (await mintDeviceToken({ userId: account.userId, secret, now: new Date(changedAt.getTime() + offset) })).token;
    expect((await guard.admit({ email: account.email, deviceToken: await token(-6_000) })).outcome).toBe('refused');
    const atBoundary = await guard.admit({ email: account.email, deviceToken: await token(-5_000) });
    expect(atBoundary.outcome).toBe('proceed');
    if (atBoundary.outcome === 'proceed') await atBoundary.settle('accepted');
  });

  it('uses the qualified default native registration path and commits password, evidence and refresh together', async () => {
    await environment.ownerDatabase.update(authEmailProjection).set({ phase: 'prepared' });
    const email = `native-evidence-${randomUUID()}@example.invalid`;
    const response = await fetch(origin, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'owned-native-password', name: 'Owned native' }),
    });
    expect(response.status).toBe(201);
    const account = (await response.json()) as { userId: string; jwt: string; refreshToken: string };
    expect(account.jwt).toBeTruthy();
    expect(account.refreshToken).toBeTruthy();
    const password = (await legacy(account.userId))[0];
    expect((await evidence(account.userId))[0].passwordFingerprint).toBe(passwordFingerprint(password.passwordHash));
    expect(
      await environment.ownerDatabase
        .select({ userId: mobileRefreshTokens.userId })
        .from(mobileRefreshTokens)
        .where(eq(mobileRefreshTokens.userId, account.userId)),
    ).toHaveLength(1);
  });

  it('rolls native identity and evidence back when refresh persistence fails after capture', async () => {
    await environment.ownerDatabase.update(authEmailProjection).set({ phase: 'prepared' });
    const email = `native-refresh-fault-${randomUUID()}@example.invalid`;
    await environment.owner`ALTER TABLE mobile_refresh_tokens ADD CONSTRAINT owned_refresh_reject CHECK (false) NOT VALID`;
    try {
      const response = await fetch(origin, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'owned-native-password' }),
      });
      expect(response.status).toBe(503);
    } finally {
      await environment.owner`ALTER TABLE mobile_refresh_tokens DROP CONSTRAINT owned_refresh_reject`;
    }
    expect(await environment.ownerDatabase.select({ id: users.id }).from(users).where(eq(users.email, email))).toEqual(
      [],
    );
  });

  it('denies default native registration before writes when capture is on with an old profile', async () => {
    vi.stubEnv('AUTH_IDENTITY_DATABASE_CONTRACT', 'private-browser-renewal-v1');
    const email = `native-old-profile-${randomUUID()}@example.invalid`;
    const response = await fetch(origin, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'owned-native-password' }),
    });
    expect(response.status).toBe(503);
    expect(await environment.ownerDatabase.select({ id: users.id }).from(users).where(eq(users.email, email))).toEqual(
      [],
    );
  });

  it('cascades evidence on deletion without allowing credential-LOGIN evidence deletion', async () => {
    const account = await fixture();
    expect(
      getPostgresErrorCode(
        await environment.database
          .delete(authPasswordChangeEvidence)
          .where(eq(authPasswordChangeEvidence.userId, account.userId))
          .catch((error: unknown) => error),
      ),
    ).toBe('42501');
    await environment.ownerDatabase.delete(users).where(eq(users.id, account.userId));
    expect(await evidence(account.userId)).toEqual([]);
  });
});
