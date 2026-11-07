import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { decodeJwt } from 'jose';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { createPrototypeNativeFacade, PrototypeNativeCredentialError } from '../identity-native-facade';
import { createPrototypeLegacyHandler } from '../legacy-bridge';
import {
  importPrototypeLegacyNativeRefresh,
  PrototypeLegacyNativeRefreshError,
  type PrototypeLegacyNativeRefreshRecord,
} from '../legacy-native-refresh';
import { PROTOTYPE_ISSUER } from '../oauth-options';
import { assertLegacyNativeTokenPair } from './identity-native-contract';

type Environment = Awaited<ReturnType<typeof createPrototypeEnvironment>>;
const SIGNING_KEY = new TextEncoder().encode('disposable-imported-native-refresh-signing-key');
const DAY_MS = 24 * 60 * 60 * 1000;
let environment: Environment;
let cutoverAt: Date;
let primary: ReturnType<typeof createPrototypeNativeFacade>;
let secondary: ReturnType<typeof createPrototypeNativeFacade>;

async function fixture(overrides: Partial<PrototypeLegacyNativeRefreshRecord> = {}) {
  const userId = randomUUID();
  await environment.database.insert(environment.schema.user).values({
    id: userId,
    name: 'Pre-cutover native fixture',
    email: `${userId}@example.test`,
    emailVerified: false,
  });
  const refreshToken = randomBytes(32).toString('hex');
  const record: PrototypeLegacyNativeRefreshRecord = {
    id: randomUUID(),
    userId,
    tokenHash: createHash('sha256').update(refreshToken).digest('hex'),
    createdAt: new Date(cutoverAt.getTime() - 30 * DAY_MS),
    expiresAt: new Date(cutoverAt.getTime() + 60 * DAY_MS),
    revokedAt: null,
    ...overrides,
  };
  return { userId, refreshToken, record };
}

function importRecord(record: PrototypeLegacyNativeRefreshRecord) {
  return importPrototypeLegacyNativeRefresh(environment.database, [record], cutoverAt);
}

async function resetUser(userId: string) {
  const token = randomUUID();
  await environment.database.insert(environment.schema.verification).values({
    id: randomUUID(),
    identifier: `reset-password:${token}`,
    value: userId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return createPrototypeLegacyHandler(environment.database)(
    new Request(`${PROTOTYPE_ISSUER}/reset-password`, {
      method: 'POST',
      headers: { origin: 'https://www.boardsesh.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token, newPassword: 'changed-after-native-snapshot' }),
    }),
  );
}

async function sessionsFor(userId: string) {
  return environment.database
    .select()
    .from(environment.schema.session)
    .where(eq(environment.schema.session.userId, userId));
}

async function canonicalLogin(userId: string) {
  const [owner] = await environment.database
    .select()
    .from(environment.schema.user)
    .where(eq(environment.schema.user.id, userId));
  await environment.database
    .insert(environment.schema.account)
    .values({
      id: `source-denial-credential:${userId}`,
      userId,
      accountId: userId,
      providerId: 'credential',
      password: await hash('source-denial-login-password', 4),
    })
    .onConflictDoNothing();
  const response = await environment.auth.api.signInEmail({
    body: { email: owner.email, password: 'source-denial-login-password' },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().find((header) => header.includes('better-auth.session_token='));
  expect(cookie).toBeDefined();
  const body = (await response.json()) as { token: string };
  const [session] = await environment.database
    .select()
    .from(environment.schema.session)
    .where(eq(environment.schema.session.token, body.token));
  expect(session.legacyLineageId).toBeNull();
  return { cookie: cookie!.split(';')[0], sessionId: session.id };
}

async function canonicalSignout(cookie: string) {
  return createPrototypeLegacyHandler(environment.database)(
    new Request(`${PROTOTYPE_ISSUER}/sign-out`, {
      method: 'POST',
      headers: { cookie, origin: 'https://www.boardsesh.test', 'content-type': 'application/json' },
      body: '{}',
    }),
  );
}

describe('pre-cutover native and Garmin refresh records backed by canonical sessions', () => {
  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    cutoverAt = new Date(Date.now() - 1000);
    primary = createPrototypeNativeFacade(environment.database, SIGNING_KEY);
    secondary = createPrototypeNativeFacade(environment.database, SIGNING_KEY);
  });
  afterAll(async () => environment?.close());

  it('accepts an installed client raw refresh after importing its exact existing hash, owner and expiry', async () => {
    const legacy = await fixture();
    const sourceBefore = JSON.stringify(legacy.record);
    expect(await importRecord(legacy.record)).toEqual({ imported: 1, alreadyBound: 0, revoked: 0, rejected: 0 });
    const [imported] = await environment.database
      .select()
      .from(environment.schema.prototypeNativeRefresh)
      .where(eq(environment.schema.prototypeNativeRefresh.tokenHash, legacy.record.tokenHash));
    expect(imported).toMatchObject({
      userId: legacy.userId,
      tokenHash: legacy.record.tokenHash,
      createdAt: legacy.record.createdAt,
      expiresAt: legacy.record.expiresAt,
      revokedAt: null,
    });
    const response = await secondary.refresh(legacy.refreshToken);
    const claims = await assertLegacyNativeTokenPair(response, SIGNING_KEY, legacy.userId);
    expect(claims.sid).toBe(imported.sessionId);
    expect(claims.auth_time).toBeUndefined();
    expect(await primary.validateAccessToken(response.jwt)).toEqual({
      userId: legacy.userId,
      sessionId: imported.sessionId,
    });
    const [session] = await sessionsFor(legacy.userId);
    expect(session.createdAt).toEqual(new Date(0));
    expect(session.originalAuthenticatedAt).toBeNull();
    expect(session.legacyLineageId).toMatch(/^credential:/);
    expect(JSON.stringify(legacy.record)).toBe(sourceBefore);
  });

  it('stores neither the raw legacy secret nor a manufactured original login time', async () => {
    const legacy = await fixture({ createdAt: new Date(cutoverAt.getTime() - 100) });
    await importRecord(legacy.record);
    const [session] = await sessionsFor(legacy.userId);
    expect(session.createdAt).toEqual(new Date(0));
    const stored = JSON.stringify({
      sessions: await sessionsFor(legacy.userId),
      tokens: await environment.database
        .select()
        .from(environment.schema.prototypeNativeRefresh)
        .where(eq(environment.schema.prototypeNativeRefresh.userId, legacy.userId)),
      bindings: await environment.database.select().from(environment.schema.verification),
    });
    expect(stored).not.toContain(legacy.refreshToken);
    const pair = await primary.refresh(legacy.refreshToken);
    expect(decodeJwt(pair.jwt).auth_time).toBeUndefined();
  });

  it('two instances import the same source once and retain one canonical session', async () => {
    const legacy = await fixture();
    const results = await Promise.all([importRecord(legacy.record), importRecord(legacy.record)]);
    expect(results.reduce((count, result) => count + result.imported, 0)).toBe(1);
    expect(results.reduce((count, result) => count + result.alreadyBound, 0)).toBe(1);
    expect(await sessionsFor(legacy.userId)).toHaveLength(1);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeNativeRefresh)
        .where(eq(environment.schema.prototypeNativeRefresh.tokenHash, legacy.record.tokenHash)),
    ).toHaveLength(1);
  });

  it('re-import after rotation never revives the consumed ancestor or destroys its valid descendant', async () => {
    const legacy = await fixture();
    await importRecord(legacy.record);
    const pair = await primary.refresh(legacy.refreshToken);
    const [consumed] = await environment.database
      .select()
      .from(environment.schema.prototypeNativeRefresh)
      .where(eq(environment.schema.prototypeNativeRefresh.tokenHash, legacy.record.tokenHash));
    expect(consumed.revokedAt).toBeInstanceOf(Date);
    expect(await importRecord(legacy.record)).toMatchObject({ imported: 0, alreadyBound: 1 });
    const [stillConsumed] = await environment.database
      .select()
      .from(environment.schema.prototypeNativeRefresh)
      .where(eq(environment.schema.prototypeNativeRefresh.tokenHash, legacy.record.tokenHash));
    expect(stillConsumed.revokedAt).toEqual(consumed.revokedAt);
    await expect(secondary.refresh(legacy.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    await assertLegacyNativeTokenPair(await secondary.refresh(pair.refreshToken), SIGNING_KEY, legacy.userId);
  });

  it('refresh racing re-import still rotates the original secret only once', async () => {
    const legacy = await fixture();
    await importRecord(legacy.record);
    const [pair] = await Promise.all([primary.refresh(legacy.refreshToken), importRecord(legacy.record)]);
    await expect(secondary.refresh(legacy.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    await assertLegacyNativeTokenPair(await secondary.refresh(pair.refreshToken), SIGNING_KEY, legacy.userId);
  });

  it('concurrent installed-client refresh permits exactly one successor', async () => {
    const legacy = await fixture();
    await importRecord(legacy.record);
    const outcomes = await Promise.allSettled([
      primary.refresh(legacy.refreshToken),
      secondary.refresh(legacy.refreshToken),
    ]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    await assertLegacyNativeTokenPair(fulfilled[0].value, SIGNING_KEY, legacy.userId);
  });

  it('preserves revoked source state and rejects an older active re-import', async () => {
    const legacy = await fixture({ revokedAt: new Date(cutoverAt.getTime() - 1) });
    expect(await importRecord(legacy.record)).toMatchObject({ imported: 0, revoked: 1 });
    expect(await importRecord({ ...legacy.record, revokedAt: null })).toMatchObject({ imported: 0, revoked: 1 });
    expect(await sessionsFor(legacy.userId)).toHaveLength(0);
    await expect(primary.refresh(legacy.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
  });

  it('later source revocation evidence removes every canonical descendant of that imported token', async () => {
    const legacy = await fixture();
    await importRecord(legacy.record);
    const pair = await primary.refresh(legacy.refreshToken);
    expect(await importRecord({ ...legacy.record, revokedAt: new Date() })).toMatchObject({ imported: 0, revoked: 1 });
    expect(await secondary.validateAccessToken(pair.jwt)).toBeNull();
    await expect(secondary.refresh(pair.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    expect(await importRecord(legacy.record)).toMatchObject({ imported: 0, revoked: 1 });
    await expect(primary.refresh(legacy.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
  });

  it('a deleted canonical session is a tombstone after importer recreation', async () => {
    const legacy = await fixture();
    await importRecord(legacy.record);
    const [session] = await sessionsFor(legacy.userId);
    await environment.database.delete(environment.schema.session).where(eq(environment.schema.session.id, session.id));
    expect(await importPrototypeLegacyNativeRefresh(environment.database, [legacy.record], cutoverAt)).toMatchObject({
      imported: 0,
      revoked: 1,
    });
    expect(await sessionsFor(legacy.userId)).toHaveLength(0);
    await expect(primary.refresh(legacy.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
  });

  it('password reset invalidates old refresh, canonical descendants and delayed imports together', async () => {
    const legacy = await fixture();
    await importRecord(legacy.record);
    const pair = await primary.refresh(legacy.refreshToken);
    expect((await resetUser(legacy.userId)).status).toBe(200);
    expect(await secondary.validateAccessToken(pair.jwt)).toBeNull();
    await expect(secondary.refresh(pair.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    expect(await importRecord(legacy.record)).toMatchObject({ imported: 0, rejected: 1 });
    await expect(primary.refresh(legacy.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
  });

  it.each(['reset-first', 'import-first'] as const)(
    'reset racing a delayed old snapshot fails closed (%s request start order)',
    async (order) => {
      const legacy = await fixture();
      const reset = () => resetUser(legacy.userId);
      const importSnapshot = () => importRecord(legacy.record);
      const outcomes =
        order === 'reset-first'
          ? await Promise.all([reset(), importSnapshot()])
          : await Promise.all([importSnapshot(), reset()]);
      const resetResponse = outcomes[order === 'reset-first' ? 0 : 1] as Response;
      expect(resetResponse.status).toBe(200);
      expect(await sessionsFor(legacy.userId)).toHaveLength(0);
      expect(await importRecord(legacy.record)).toMatchObject({ imported: 0, rejected: 1 });
      await expect(primary.refresh(legacy.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    },
  );

  it('an account signout cannot be undone by re-importing the old snapshot', async () => {
    const legacy = await fixture();
    await importRecord(legacy.record);
    const pair = await primary.refresh(legacy.refreshToken);
    await secondary.revoke(pair.refreshToken);
    expect(await importRecord(legacy.record)).toMatchObject({ imported: 0, rejected: 1 });
    expect(await primary.validateAccessToken(pair.jwt)).toBeNull();
    await expect(secondary.refresh(legacy.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
  });

  it('deleting the original user rejects both refresh and a stale snapshot', async () => {
    const legacy = await fixture();
    await importRecord(legacy.record);
    const pair = await primary.refresh(legacy.refreshToken);
    await environment.database.delete(environment.schema.user).where(eq(environment.schema.user.id, legacy.userId));
    expect(await importRecord(legacy.record)).toMatchObject({ imported: 0, rejected: 1 });
    expect(await secondary.validateAccessToken(pair.jwt)).toBeNull();
    await expect(secondary.refresh(pair.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
  });

  it('an immutable source record cannot change owner, token hash or expiry on re-import', async () => {
    const legacy = await fixture();
    const other = await fixture();
    await importRecord(legacy.record);
    for (const changed of [
      { ...legacy.record, userId: other.userId },
      { ...legacy.record, tokenHash: other.record.tokenHash },
      { ...legacy.record, expiresAt: new Date(legacy.record.expiresAt.getTime() + 1000) },
    ])
      expect(await importRecord(changed)).toMatchObject({ imported: 0, rejected: 1 });
    const pair = await primary.refresh(legacy.refreshToken);
    expect(pair.userId).toBe(legacy.userId);
    expect(await sessionsFor(other.userId)).toHaveLength(0);
  });

  it('duplicate source IDs and cross-account token hashes reject the entire ambiguous group', async () => {
    const first = await fixture();
    const second = await fixture();
    const records = [first.record, { ...second.record, tokenHash: first.record.tokenHash }];
    expect(await importPrototypeLegacyNativeRefresh(environment.database, records, cutoverAt)).toMatchObject({
      imported: 0,
      rejected: 2,
    });
    expect(
      await importPrototypeLegacyNativeRefresh(environment.database, [first.record, first.record], cutoverAt),
    ).toMatchObject({ imported: 0, rejected: 2 });
    expect(await sessionsFor(first.userId)).toHaveLength(0);
    expect(await sessionsFor(second.userId)).toHaveLength(0);
  });

  it.each([
    ['plaintext instead of a hash', { tokenHash: 'not-a-sha256-hash' }],
    ['expiry already passed', { expiresAt: new Date(0) }],
    ['invalid issue date', { createdAt: new Date(Number.NaN) }],
    ['revocation before issuance', { revokedAt: new Date(0) }],
    ['future revocation', { revokedAt: new Date(Date.now() + DAY_MS) }],
    ['missing owner', { userId: 'nonexistent-canonical-user' }],
  ] satisfies [string, Partial<PrototypeLegacyNativeRefreshRecord>][])(
    'rejects %s without issuing a session',
    async (_label, changed) => {
      const legacy = await fixture(changed);
      expect(await importRecord(legacy.record)).toMatchObject({ imported: 0, rejected: 1 });
      expect(await sessionsFor(legacy.userId)).toHaveLength(0);
    },
  );

  it('rejects active issuance after cutover and a remaining lifetime beyond the accepted horizon', async () => {
    const legacy = await fixture();
    expect(await importRecord({ ...legacy.record, createdAt: new Date(cutoverAt.getTime() + 1) })).toMatchObject({
      imported: 0,
      rejected: 1,
    });
    expect(
      await importRecord({ ...legacy.record, expiresAt: new Date(cutoverAt.getTime() + 90 * DAY_MS + 1) }),
    ).toMatchObject({ imported: 0, rejected: 1 });
  });

  it('handler recreation cannot move the fixed cutover boundary to admit a delayed record', async () => {
    const legacy = await fixture();
    await importRecord(legacy.record);
    await expect(
      importPrototypeLegacyNativeRefresh(environment.database, [legacy.record], new Date(cutoverAt.getTime() + 1)),
    ).rejects.toBeInstanceOf(PrototypeLegacyNativeRefreshError);
    expect(await sessionsFor(legacy.userId)).toHaveLength(1);
  });

  it('a post-import fault rolls back session, native secret, lineage and immutable binding together', async () => {
    const legacy = await fixture();
    let reached = false;
    await expect(
      importPrototypeLegacyNativeRefresh(environment.database, [legacy.record], cutoverAt, async () => {
        reached = true;
        throw new Error('Synthetic import failure');
      }),
    ).rejects.toThrow('Synthetic import failure');
    expect(reached).toBe(true);
    expect(await sessionsFor(legacy.userId)).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeNativeRefresh)
        .where(eq(environment.schema.prototypeNativeRefresh.tokenHash, legacy.record.tokenHash)),
    ).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeLegacyLineage)
        .where(eq(environment.schema.prototypeLegacyLineage.userId, legacy.userId)),
    ).toHaveLength(0);
    expect(await importRecord(legacy.record)).toMatchObject({ imported: 1 });
  });

  it('captures immutable source dates before waiting for the common lifecycle fence', async () => {
    const legacy = await fixture();
    const originalExpiry = new Date(legacy.record.expiresAt);
    const originalCutover = new Date(cutoverAt);
    const boundary = new Date(cutoverAt);
    let resolveEntered!: () => void;
    let releaseFence!: () => void;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    const fence = environment.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(6975, 1)`);
      resolveEntered();
      await release;
    });
    await entered;
    const pending = importPrototypeLegacyNativeRefresh(environment.database, [legacy.record], boundary);
    legacy.record.expiresAt.setTime(originalExpiry.getTime() + 365 * DAY_MS);
    boundary.setTime(boundary.getTime() + DAY_MS);
    releaseFence();
    await fence;
    expect(await pending).toMatchObject({ imported: 1 });
    const [row] = await environment.database
      .select()
      .from(environment.schema.prototypeNativeRefresh)
      .where(eq(environment.schema.prototypeNativeRefresh.tokenHash, legacy.record.tokenHash));
    expect(row.expiresAt).toEqual(originalExpiry);
    expect(
      await importPrototypeLegacyNativeRefresh(
        environment.database,
        [{ ...legacy.record, expiresAt: originalExpiry }],
        originalCutover,
      ),
    ).toMatchObject({ alreadyBound: 1 });
  });

  it('preserves expiry when the database transaction timestamp precedes application issuance', async () => {
    const legacy = await fixture({
      createdAt: new Date(cutoverAt.getTime() - 1500),
      expiresAt: new Date(cutoverAt.getTime() + 90 * DAY_MS),
    });
    expect(legacy.record.expiresAt.getTime() - legacy.record.createdAt.getTime()).toBeGreaterThan(90 * DAY_MS);
    expect(await importRecord(legacy.record)).toMatchObject({ imported: 1 });
    const [row] = await environment.database
      .select()
      .from(environment.schema.prototypeNativeRefresh)
      .where(eq(environment.schema.prototypeNativeRefresh.tokenHash, legacy.record.tokenHash));
    expect(row.expiresAt).toEqual(legacy.record.expiresAt);
    expect((await sessionsFor(legacy.userId))[0].createdAt).toEqual(new Date(0));
  });

  it('stock expired-verification cleanup cannot reopen the native migration epoch after 90 days', async () => {
    const isolated = await createPrototypeEnvironment();
    const boundary = new Date(Date.now() - 1000);
    const userId = randomUUID();
    const original: PrototypeLegacyNativeRefreshRecord = {
      id: randomUUID(),
      userId,
      tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
      createdAt: new Date(boundary.getTime() - DAY_MS),
      expiresAt: new Date(boundary.getTime() + 60 * DAY_MS),
      revokedAt: null,
    };
    try {
      await isolated.database.insert(isolated.schema.user).values({
        id: userId,
        name: 'Durable migration epoch fixture',
        email: `${userId}@example.test`,
        emailVerified: false,
      });
      expect(await importPrototypeLegacyNativeRefresh(isolated.database, [original], boundary)).toMatchObject({
        imported: 1,
      });
      await isolated.database.insert(isolated.schema.verification).values({
        id: 'expired-epoch-regression',
        identifier: 'expired-epoch-regression',
        value: boundary.toISOString(),
        expiresAt: new Date(boundary.getTime() + 90 * DAY_MS),
      });
      const authContext = await isolated.auth.$context;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(boundary.getTime() + 91 * DAY_MS);
      // This is the real provider cleanup path that erased the first prototype
      // epoch. It removes expired bindings but cannot touch permanent metadata.
      await authContext.internalAdapter.findVerificationValue('no-matching-verification');
      expect(await isolated.database.select().from(isolated.schema.verification)).toHaveLength(0);
      const [epoch] = await isolated.database
        .select()
        .from(isolated.schema.prototypeAuthMigrationEpoch)
        .where(eq(isolated.schema.prototypeAuthMigrationEpoch.name, 'native-refresh'));
      expect(epoch.cutoverAt).toEqual(boundary);
      const laterBoundary = new Date(Date.now() - 1000);
      const postCutover: PrototypeLegacyNativeRefreshRecord = {
        ...original,
        id: randomUUID(),
        tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
        createdAt: new Date(boundary.getTime() + DAY_MS),
        expiresAt: new Date(Date.now() + 60 * DAY_MS),
      };
      await expect(
        importPrototypeLegacyNativeRefresh(isolated.database, [postCutover], laterBoundary),
      ).rejects.toBeInstanceOf(PrototypeLegacyNativeRefreshError);
      expect(
        await isolated.database
          .select()
          .from(isolated.schema.prototypeNativeRefresh)
          .where(eq(isolated.schema.prototypeNativeRefresh.tokenHash, postCutover.tokenHash)),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await isolated.close();
    }
  });

  it('a failed first import rolls back the permanent migration epoch together with every credential row', async () => {
    const isolated = await createPrototypeEnvironment();
    const boundary = new Date(Date.now() - 1000);
    const userId = randomUUID();
    const record: PrototypeLegacyNativeRefreshRecord = {
      id: randomUUID(),
      userId,
      tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
      createdAt: new Date(boundary.getTime() - DAY_MS),
      expiresAt: new Date(boundary.getTime() + 60 * DAY_MS),
      revokedAt: null,
    };
    try {
      await isolated.database.insert(isolated.schema.user).values({
        id: userId,
        name: 'First import rollback fixture',
        email: `${userId}@example.test`,
        emailVerified: false,
      });
      let reached = false;
      await expect(
        importPrototypeLegacyNativeRefresh(isolated.database, [record], boundary, async () => {
          reached = true;
          throw new Error('Synthetic first import failure');
        }),
      ).rejects.toThrow('Synthetic first import failure');
      expect(reached).toBe(true);
      expect(await isolated.database.select().from(isolated.schema.prototypeAuthMigrationEpoch)).toHaveLength(0);
      expect(await isolated.database.select().from(isolated.schema.session)).toHaveLength(0);
      expect(await isolated.database.select().from(isolated.schema.prototypeNativeRefresh)).toHaveLength(0);
      expect(await isolated.database.select().from(isolated.schema.prototypeLegacyLineage)).toHaveLength(0);
      expect(await isolated.database.select().from(isolated.schema.verification)).toHaveLength(0);
      const retryBoundary = new Date(boundary.getTime() + 1);
      expect(await importPrototypeLegacyNativeRefresh(isolated.database, [record], retryBoundary)).toMatchObject({
        imported: 1,
      });
      const [epoch] = await isolated.database.select().from(isolated.schema.prototypeAuthMigrationEpoch);
      expect(epoch.cutoverAt).toEqual(retryBoundary);
    } finally {
      await isolated.close();
    }
  });

  it('actual canonical sign-out rejects a delayed unseen user-only refresh snapshot', async () => {
    const legacy = await fixture();
    const canonical = await canonicalLogin(legacy.userId);
    expect((await canonicalSignout(canonical.cookie)).status).toBe(200);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, legacy.userId)),
    ).toHaveLength(0);
    expect(await importRecord(legacy.record)).toMatchObject({ imported: 0, rejected: 1 });
    expect(await sessionsFor(legacy.userId)).toHaveLength(0);
    await expect(primary.refresh(legacy.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
  });

  it('signing out one canonical session preserves a known imported binding and another canonical session', async () => {
    const legacy = await fixture();
    await importRecord(legacy.record);
    const departing = await canonicalLogin(legacy.userId);
    const remaining = await canonicalLogin(legacy.userId);
    expect((await canonicalSignout(departing.cookie)).status).toBe(200);
    const unknownRaw = randomBytes(32).toString('hex');
    const unseen = {
      ...legacy.record,
      id: randomUUID(),
      tokenHash: createHash('sha256').update(unknownRaw).digest('hex'),
    };
    expect(
      await importPrototypeLegacyNativeRefresh(environment.database, [legacy.record, unseen], cutoverAt),
    ).toMatchObject({ imported: 0, alreadyBound: 1, rejected: 1 });
    const current = await environment.auth.api.getSession({ headers: new Headers({ cookie: remaining.cookie }) });
    expect(current?.session.id).toBe(remaining.sessionId);
    const pair = await secondary.refresh(legacy.refreshToken);
    await assertLegacyNativeTokenPair(pair, SIGNING_KEY, legacy.userId);
    expect(await primary.validateAccessToken(pair.jwt)).not.toBeNull();
    await expect(primary.refresh(unknownRaw)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeUserCutoff)
        .where(eq(environment.schema.prototypeUserCutoff.userId, legacy.userId)),
    ).toHaveLength(0);
  });

  it('handler recreation and stock verification cleanup cannot erase a canonical sign-out source denial', async () => {
    const legacy = await fixture();
    const canonical = await canonicalLogin(legacy.userId);
    expect((await canonicalSignout(canonical.cookie)).status).toBe(200);
    await environment.database.insert(environment.schema.verification).values({
      id: `expired-source-cleanup:${legacy.userId}`,
      identifier: `expired-source-cleanup:${legacy.userId}`,
      value: 'expired-source-cleanup',
      expiresAt: new Date(Date.now() - 1),
    });
    await (await environment.auth.$context).internalAdapter.findVerificationValue('nonexistent-source-cleanup');
    expect(
      await environment.database
        .select()
        .from(environment.schema.verification)
        .where(eq(environment.schema.verification.id, `expired-source-cleanup:${legacy.userId}`)),
    ).toHaveLength(0);
    const history = await environment.database
      .select()
      .from(environment.schema.prototypeLegacyLineage)
      .where(eq(environment.schema.prototypeLegacyLineage.userId, legacy.userId));
    expect(history.some((entry) => entry.id.startsWith('canonical-signout:') && entry.revokedAt !== null)).toBe(true);
    const recreatedNative = createPrototypeNativeFacade(environment.database, SIGNING_KEY);
    expect(
      await importPrototypeLegacyNativeRefresh(environment.database, [legacy.record], new Date(cutoverAt)),
    ).toMatchObject({ imported: 0, rejected: 1 });
    await expect(recreatedNative.refresh(legacy.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    expect(await sessionsFor(legacy.userId)).toHaveLength(0);
  });

  it.each(['missing', 'expired'] as const)(
    'an unseen source cannot bypass %s canonical lineage history',
    async (state) => {
      const legacy = await fixture();
      await importRecord(legacy.record);
      const [session] = await sessionsFor(legacy.userId);
      if (state === 'missing') {
        await environment.database
          .delete(environment.schema.session)
          .where(eq(environment.schema.session.id, session.id));
      } else {
        await environment.database
          .update(environment.schema.session)
          .set({ expiresAt: new Date(0) })
          .where(eq(environment.schema.session.id, session.id));
      }
      const unknownRaw = randomBytes(32).toString('hex');
      const unseen = {
        ...legacy.record,
        id: randomUUID(),
        tokenHash: createHash('sha256').update(unknownRaw).digest('hex'),
      };
      expect(await importRecord(unseen)).toMatchObject({ imported: 0, rejected: 1 });
      await expect(primary.refresh(unknownRaw)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
      expect(
        await environment.database
          .select()
          .from(environment.schema.prototypeUserCutoff)
          .where(eq(environment.schema.prototypeUserCutoff.userId, legacy.userId)),
      ).toHaveLength(0);
    },
  );
});
