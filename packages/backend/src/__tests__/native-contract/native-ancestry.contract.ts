import { createHmac, createHash, randomUUID, randomInt } from 'node:crypto';
import { EncryptJWT, decodeJwt } from 'jose';
import { hkdf } from '@panva/hkdf';
import { hash } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AUTH_PROTOCOL_VERSION } from '@boardsesh/auth-protocol';
import {
  users,
  userCredentials,
  mobileRefreshTokens,
  authEmailProjection,
  authCredentialLineage,
  authSession,
} from '@boardsesh/db/schema';
import { createNativeHttpFixture } from './http-fixture';
import { recordings } from './recordings';
import { createReleasedClient, callRecorded } from './released-client';
import {
  UNKNOWN_WEB_NATIVE_SESSION_PREFIX,
  nativeSessionRequiresAccountCutoff,
} from '../../auth/native-session-ancestry';
import { parseWatchPairCapability } from '../../auth/watch-pairing-capability';

let fixture: Awaited<ReturnType<typeof createNativeHttpFixture>>;
let foundation: typeof import('../../auth/current-store/foundation-context');
let reservations: typeof import('../../auth/current-store/email-reservations');
let readers: typeof import('../../auth/authority/session-reader');
let lineage: typeof import('../../auth/authority/lineage');
let revocation: typeof import('../../auth/authority/native-revocation-configuration');
let recovery: typeof import('../../auth/current-store/password-recovery');
let userId: string;
let email: string;
let passwordHash: string;
const password = 'owned-ancestry-password';
const nextPassword = 'owned-ancestry-next-password';
const projectionId = randomUUID();
const authority = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: 'js-trim-lower-v1',
  expectedWriterEpoch: 1,
  emailVerificationEnabled: false,
};
const redisKeys = new Set<string>();
interface Pair {
  jwt: string;
  refreshToken: string;
  expiresAt: string;
  userId: string;
}
async function pair(response: Response): Promise<Pair> {
  expect(response.status).toBe(200);
  const reply = (await response.json()) as Pair;
  expect(typeof reply.jwt).toBe('string');
  expect(typeof reply.refreshToken).toBe('string');
  return reply;
}
function transfer(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encoded = Buffer.from(
    JSON.stringify({ userId, nextPath: `/${randomUUID()}`, gen: 0, iat: now, exp: now + 120, ...overrides }),
  ).toString('base64url');
  return `${encoded}.${createHmac('sha256', process.env.NEXTAUTH_SECRET!).update(encoded).digest('base64url')}`;
}
async function rawWeb(overrides: Record<string, unknown> = {}, maxAgeSeconds = 3600) {
  const key = await hkdf(
    'sha256',
    new TextEncoder().encode(process.env.NEXTAUTH_SECRET!),
    '',
    'NextAuth.js Generated Encryption Key',
    32,
  );
  return new EncryptJWT({ sub: userId, gen: 0, ...overrides })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + maxAgeSeconds)
    .encrypt(key);
}
async function signIn(secret = password) {
  return pair(await fixture.post('/auth/native/credentials', { email, password: secret }));
}
async function issueCode(credential: string) {
  const response = await fixture.post('/api/watch/pair-code', {}, credential);
  expect(response.status).toBe(200);
  const reply = (await response.json()) as { code: string; expiresAt: string };
  expect(reply.code).toMatch(/^[A-Z2-9]{8}$/);
  const key = `boardsesh:watch:pair:${reply.code}`;
  redisKeys.add(key);
  return { ...reply, key };
}
async function legacyPendingCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
  const key = `boardsesh:watch:pair:${code}`;
  expect(await fixture.redis.getClients().publisher.set(key, userId, 'EX', 300, 'NX')).toBe('OK');
  redisKeys.add(key);
  return { code, key };
}
async function resetPassword() {
  const requested = await recovery.requestPasswordRecovery(fixture.db, authority, {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'forgot-password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { email },
  });
  if (requested.outcome !== 'accepted' || !requested.mailPlan) throw new Error('Owned recovery plan absent');
  return recovery.consumePasswordRecovery(fixture.db, authority, {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'reset-password',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    payload: { token: requested.mailPlan.token, email, password: nextPassword, confirmPassword: nextPassword },
  });
}
function qualifyNativeCanonicalCore() {
  // Function-level qualification only. Production's Garmin activation guard
  // remains unchanged and is checked by the existing native-mode suite.
  vi.spyOn(revocation, 'currentNativeRevocationMode').mockReturnValue('generation');
  vi.stubEnv('AUTH_LEGACY_BRIDGE_MODE', 'on');
}

beforeAll(async () => {
  fixture = await createNativeHttpFixture();
  foundation = await import('../../auth/current-store/foundation-context');
  reservations = await import('../../auth/current-store/email-reservations');
  readers = await import('../../auth/authority/session-reader');
  lineage = await import('../../auth/authority/lineage');
  revocation = await import('../../auth/authority/native-revocation-configuration');
  recovery = await import('../../auth/current-store/password-recovery');
  const { handleCurrentStoreWebSignOut } = await import('../../handlers/current-store-web-signout');
  fixture.mount('/signout', (request, response) => handleCurrentStoreWebSignOut(request, response, fixture.db));
  passwordHash = await hash(password, 4);
  await fixture.db.transaction(async (transaction) => {
    await reservations.prepareProjectionUnderUsersTableLock(transaction, { projectionId });
    await transaction.update(authEmailProjection).set({ phase: 'enforced' });
  });
});
beforeEach(async () => {
  fixture.native.__resetNativeAuthStateForTests();
  vi.stubEnv('AUTH_WATCH_PAIRING_MODE', 'source-bound-staging');
  vi.stubEnv('AUTH_LEGACY_BRIDGE_MODE', 'off');
  vi.stubEnv('AUTH_NATIVE_REVOCATION_MODE', 'legacy');
  vi.stubEnv('AUTH_CUTOFF_ENFORCEMENT', 'enforce');
  vi.stubEnv('AUTH_IDENTITY_MIRROR', 'off');
  vi.stubEnv('CURRENT_STORE_WEB_SIGNOUT_MODE', 'backend-staging');
  vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', 'required');
  vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
  vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
  vi.stubEnv('CURRENT_STORE_AUTH_RPC_SECRET', 'owned-native-ancestry-private-rpc-secret');
  vi.stubEnv('CURRENT_STORE_DELETED_EMAIL_KEY', 'owned-native-ancestry-deleted-email-key');
  userId = randomUUID();
  email = `ancestry-${userId}@example.test`;
  await fixture.db.transaction(async (transaction) => {
    await foundation.lockEnforcedProjection(transaction, authority);
    await foundation.lockEmailKeyForCreation(transaction, email);
    await transaction.insert(users).values({ id: userId, email, name: 'Owned ancestry climber' });
    await reservations.reserveEnforcedEmail(transaction, { ...authority, rawEmail: email, requestedUserId: userId });
    await transaction.insert(userCredentials).values({ userId, passwordHash });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  if (fixture) {
    if (redisKeys.size) await fixture.redis.getClients().publisher.del(...redisKeys);
    await fixture.close();
  }
});

function deferred() {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release };
}
async function observeWait(event: 'Lock' | 'Timeout', queryPart: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const rows =
      await fixture.connection`SELECT 1 FROM pg_stat_activity WHERE datname = ${fixture.ownership.databaseName}
      AND pid <> pg_backend_pid() AND wait_event_type = ${event} AND query LIKE ${`%${queryPart}%`}`;
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Owned native statement wait was not observed');
}

describe('actual exchange, refresh and source-bound watch capability ancestry', () => {
  it.each([{}, { authSessionId: randomUUID(), legacy_no_sid: true }])(
    'conservatively binds observable unknown transfer ancestry %j through native refresh and canonical logout',
    async (source) => {
      const raw = await rawWeb({ authSessionId: source.authSessionId, legacy_no_sid: true });
      const exchanged = await pair(await fixture.post('/auth/native/exchange', { transferToken: transfer(source) }));
      const first = decodeJwt(exchanged.jwt);
      expect(first.sid).toMatch(new RegExp(`^${UNKNOWN_WEB_NATIVE_SESSION_PREFIX}`));
      expect(first.auth_time).toBeUndefined();
      const rotated = await pair(await fixture.post('/auth/native/refresh', { refreshToken: exchanged.refreshToken }));
      expect(decodeJwt(rotated.jwt)).toMatchObject({ sid: first.sid, gen: 0, ngen: 0 });
      qualifyNativeCanonicalCore();
      const canonicalChild = await pair(
        await fixture.post('/auth/native/refresh', { refreshToken: rotated.refreshToken }),
      );
      const [canonical] = await fixture.db
        .select()
        .from(authSession)
        .where(eq(authSession.id, String(first.sid)));
      expect(canonical.legacyLineageId).toMatch(/^credential:native-refresh:/);
      await fixture.db.delete(authCredentialLineage).where(eq(authCredentialLineage.id, canonical.legacyLineageId!));
      const read = await readers.readFirstPartySession(fixture.db, { kind: 'canonical-token', token: canonical.token });
      if (read.status !== 'admitted') throw new Error('Owned canonical descendant not admitted');
      expect(read.session.requiresAccountCutoff).toBe(true);
      await lineage.denyFirstPartySession(fixture.db, read.session, new Date(), authority);
      expect(
        (
          await readers.readFirstPartySession(fixture.db, {
            kind: 'legacy-jwe',
            credential: raw,
            secret: process.env.NEXTAUTH_SECRET!,
          })
        ).status,
      ).toBe('denied');
      expect((await fixture.post('/auth/native/refresh', { refreshToken: canonicalChild.refreshToken })).status).toBe(
        401,
      );
      const later = await signIn();
      const delayed = await fetch(`${fixture.origin}/signout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer owned-native-ancestry-private-rpc-secret',
        },
        body: JSON.stringify({
          protocolVersion: AUTH_PROTOCOL_VERSION,
          operation: 'signout',
          requestId: randomUUID(),
          issuedAt: Date.now(),
          payload: { credential: raw },
        }),
      });
      expect(delayed.status).toBe(200);
      expect(
        decodeJwt((await pair(await fixture.post('/auth/native/refresh', { refreshToken: later.refreshToken }))).jwt)
          .gen,
      ).toBe(1);
    },
  );

  it.each([false, null, 0, 'true'])(
    'refuses malformed signed transfer marker %j before native issuance',
    async (legacy_no_sid) => {
      expect(
        (
          await fixture.post('/auth/native/exchange', {
            transferToken: transfer({ authSessionId: randomUUID(), legacy_no_sid }),
          })
        ).status,
      ).toBe(401);
      expect(
        await fixture.db.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, userId)),
      ).toHaveLength(0);
    },
  );

  it('retains ordinary stable source lineage, exact original age and a distinct native login', async () => {
    const authenticatedAt = Math.floor(Date.now() / 1000) - 600;
    const sourceSid = randomUUID();
    const result = await pair(
      await fixture.post('/auth/native/exchange', {
        transferToken: transfer({ authSessionId: sourceSid, auth_time: authenticatedAt, link_guarded: true }),
      }),
    );
    const proof = decodeJwt(result.jwt);
    expect(proof.sid).not.toBe(sourceSid);
    expect(nativeSessionRequiresAccountCutoff(String(proof.sid))).toBe(false);
    expect(proof.auth_time).toBe(authenticatedAt);
    const refreshed = await pair(await fixture.post('/auth/native/refresh', { refreshToken: result.refreshToken }));
    expect(decodeJwt(refreshed.jwt)).toMatchObject({ sid: proof.sid, auth_time: authenticatedAt });
  });

  it.each(['credential-web:v2:other', 'credential-web:v1:not-a-uuid', ` credential-web:v1:${randomUUID()}`])(
    'refuses malformed reserved SID %s rather than treating it as stable',
    async (authSessionId) => {
      expect((await fixture.post('/auth/native/exchange', { transferToken: transfer({ authSessionId }) })).status).toBe(
        401,
      );
    },
  );

  it('rolls back rotation on a conflicting reserved canonical SID without overwriting its owner', async () => {
    const exchanged = await pair(
      await fixture.post('/auth/native/exchange', { transferToken: transfer({ legacy_no_sid: true }) }),
    );
    const sid = String(decodeJwt(exchanged.jwt).sid);
    const otherId = randomUUID();
    await fixture.db.insert(users).values({ id: otherId, email: `collision-${otherId}@example.test` });
    await fixture.db.insert(authSession).values({
      id: sid,
      token: randomUUID(),
      userId: otherId,
      expiresAt: new Date(Date.now() + 86400000),
      legacyLineageId: 'native-refresh:conflict',
      revocationGeneration: 0,
    });
    qualifyNativeCanonicalCore();
    expect((await fixture.post('/auth/native/refresh', { refreshToken: exchanged.refreshToken })).status).toBe(401);
    const [parent] = await fixture.db
      .select()
      .from(mobileRefreshTokens)
      .where(eq(mobileRefreshTokens.tokenHash, createHash('sha256').update(exchanged.refreshToken).digest('hex')));
    expect(parent.revokedAt).toBeNull();
    expect((await fixture.db.select().from(authSession).where(eq(authSession.id, sid)))[0].userId).toBe(otherId);
  });

  it('native signout retires marked native canonical bindings while retaining the source website session', async () => {
    const sourceSid = randomUUID();
    const raw = await rawWeb({ authSessionId: sourceSid, legacy_no_sid: true });
    const exchanged = await pair(
      await fixture.post('/auth/native/exchange', {
        transferToken: transfer({ authSessionId: sourceSid, legacy_no_sid: true }),
      }),
    );
    qualifyNativeCanonicalCore();
    const child = await pair(await fixture.post('/auth/native/refresh', { refreshToken: exchanged.refreshToken }));
    const sid = String(decodeJwt(child.jwt).sid);
    const [canonical] = await fixture.db.select().from(authSession).where(eq(authSession.id, sid));
    expect(canonical.legacyLineageId).toMatch(/^credential:native-refresh:/);
    expect((await fixture.post('/auth/native/revoke', { refreshToken: child.refreshToken })).status).toBe(200);
    expect(
      (await readers.readFirstPartySession(fixture.db, { kind: 'canonical-token', token: canonical.token })).status,
    ).toBe('denied');
    expect(
      (
        await readers.readFirstPartySession(fixture.db, {
          kind: 'legacy-jwe',
          credential: raw,
          secret: process.env.NEXTAUTH_SECRET!,
        })
      ).status,
    ).toBe('admitted');
    const later = await signIn();
    expect((await fixture.post('/auth/native/revoke', { refreshToken: child.refreshToken })).status).toBe(401);
    expect((await fixture.post('/auth/native/refresh', { refreshToken: later.refreshToken })).status).toBe(200);
  });

  it('retains the installed inclusive transfer clock-tolerance window', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      (await fixture.post('/auth/native/exchange', { transferToken: transfer({ iat: now - 121, exp: now - 1 }) }))
        .status,
    ).toBe(200);
  });

  it('does not mint from a transfer that expires while the real issuer waits for the user lock', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = transfer({ iat: now - 124, exp: now - 4 });
    const held = deferred(),
      release = deferred();
    const blocker = fixture.db.transaction(async (transaction) => {
      await transaction.select().from(users).where(eq(users.id, userId)).for('update');
      held.release();
      await release.pending;
    });
    await held.pending;
    const pending = fixture.post('/auth/native/exchange', { transferToken: token });
    try {
      await observeWait('Lock', 'for key share');
      await new Promise((resolve) => setTimeout(resolve, 2_100));
    } finally {
      release.release();
      await blocker;
    }
    expect((await pending).status).toBe(401);
    expect((await fixture.post('/auth/native/exchange', { transferToken: token })).status).toBe(409);
    expect(
      await fixture.db.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, userId)),
    ).toHaveLength(0);
  });

  it.each(['web', 'native'] as const)(
    'preserves historical %s ancestry and unknown age across v2 watch pairing and refresh',
    async (sourceKind) => {
      const sourceSid = randomUUID();
      const raw = await rawWeb({ authSessionId: sourceSid, legacy_no_sid: true });
      const source =
        sourceKind === 'web'
          ? raw
          : (
              await pair(
                await fixture.post('/auth/native/exchange', {
                  transferToken: transfer({ authSessionId: sourceSid, legacy_no_sid: true }),
                }),
              )
            ).jwt;
      const issued = await issueCode(source);
      const contents = await fixture.redis.getClients().publisher.get(issued.key);
      const capability = parseWatchPairCapability(contents!);
      expect(capability?.source).toMatchObject({
        kind: sourceKind,
        generation: 0,
        requiresAccountCutoff: true,
        authenticatedAt: null,
      });
      const watch = await pair(await fixture.post('/api/watch/pair', { code: issued.code }));
      expect(decodeJwt(watch.jwt).sid).toMatch(new RegExp(`^${UNKNOWN_WEB_NATIVE_SESSION_PREFIX}`));
      expect(decodeJwt(watch.jwt).auth_time).toBeUndefined();
      expect(
        decodeJwt((await pair(await fixture.post('/auth/native/refresh', { refreshToken: watch.refreshToken }))).jwt)
          .sid,
      ).toBe(decodeJwt(watch.jwt).sid);
      expect((await fixture.post('/api/watch/pair', { code: issued.code })).status).toBe(401);
    },
  );

  it('copies the source authentication age into a watch pair instead of the new code creation time', async () => {
    const authenticatedAt = Math.floor(Date.now() / 1000) - 600;
    const issued = await issueCode(
      await rawWeb({ authSessionId: randomUUID(), auth_time: authenticatedAt, link_guarded: true }),
    );
    const capability = parseWatchPairCapability((await fixture.redis.getClients().publisher.get(issued.key))!);
    expect(capability?.source.authenticatedAt).toBe(authenticatedAt);
    const watch = await pair(await fixture.post('/api/watch/pair', { code: issued.code }));
    expect(decodeJwt(watch.jwt).auth_time).toBe(authenticatedAt);
    const rotated = await pair(await fixture.post('/auth/native/refresh', { refreshToken: watch.refreshToken }));
    expect(decodeJwt(rotated.jwt).auth_time).toBe(authenticatedAt);
  });

  it('refuses a pre-reset v2 code terminally and leaves the later password login usable', async () => {
    const signedIn = await signIn();
    const issued = await issueCode(signedIn.jwt);
    expect((await resetPassword()).outcome).toBe('reset');
    expect((await fixture.post('/api/watch/pair', { code: issued.code })).status).toBe(401);
    expect(await fixture.redis.getClients().publisher.get(issued.key)).toBeNull();
    expect((await fixture.post('/api/watch/pair', { code: issued.code })).status).toBe(401);
    const later = await signIn(nextPassword);
    const freshCode = await issueCode(later.jwt);
    expect(decodeJwt((await pair(await fixture.post('/api/watch/pair', { code: freshCode.code }))).jwt).gen).toBe(1);
  });

  it('refuses a v2 capability after its stable web source SID signs out without changing account generation', async () => {
    const raw = await rawWeb({ authSessionId: randomUUID() });
    const issued = await issueCode(raw);
    const signedOut = await fetch(`${fixture.origin}/signout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer owned-native-ancestry-private-rpc-secret',
      },
      body: JSON.stringify({
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'signout',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload: { credential: raw },
      }),
    });
    expect(signedOut.status).toBe(200);
    expect((await fixture.post('/api/watch/pair', { code: issued.code })).status).toBe(401);
    expect(await fixture.redis.getClients().publisher.get(issued.key)).toBeNull();
    expect(decodeJwt((await signIn()).jwt).gen).toBe(0);
  });

  it('binds native-source pairing to native signout while a web-source handoff remains independent', async () => {
    const native = await signIn();
    const nativeCode = await issueCode(native.jwt);
    const webCode = await issueCode(await rawWeb({ authSessionId: randomUUID() }));
    vi.spyOn(revocation, 'currentNativeRevocationMode').mockReturnValue('generation');
    expect((await fixture.post('/auth/native/revoke', { refreshToken: native.refreshToken })).status).toBe(200);
    expect((await fixture.post('/api/watch/pair', { code: nativeCode.code })).status).toBe(401);
    const watch = await pair(await fixture.post('/api/watch/pair', { code: webCode.code }));
    expect(decodeJwt(watch.jwt)).toMatchObject({ gen: 0, ngen: 1 });
  });

  it('rechecks primary after an in-flight real password reset releases the user lock', async () => {
    const source = await signIn();
    const issued = await issueCode(source.jwt);
    await fixture.connection.unsafe(
      `CREATE FUNCTION ancestry_reset_sleep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $$`,
    );
    await fixture.connection.unsafe(
      `CREATE TRIGGER ancestry_reset_sleep BEFORE UPDATE ON user_credentials FOR EACH ROW EXECUTE FUNCTION ancestry_reset_sleep()`,
    );
    const resetting = resetPassword();
    let consuming: Promise<Response> | undefined;
    try {
      await observeWait('Timeout', 'user_credentials');
      consuming = fixture.post('/api/watch/pair', { code: issued.code });
      await observeWait('Lock', 'for key share');
      expect((await resetting).outcome).toBe('reset');
      expect((await consuming).status).toBe(401);
    } finally {
      await Promise.allSettled([resetting, ...(consuming ? [consuming] : [])]);
      await fixture.connection.unsafe('DROP TRIGGER ancestry_reset_sleep ON user_credentials');
      await fixture.connection.unsafe('DROP FUNCTION ancestry_reset_sleep()');
    }
    expect(await fixture.redis.getClients().publisher.get(issued.key)).toBeNull();
    expect((await signIn(nextPassword)).jwt).toBeTruthy();
  });

  it('keeps compare-and-delete bound to the exact v2 nonce when the same user replaces a code', async () => {
    const source = await signIn();
    const issued = await issueCode(source.jwt);
    const contents = await fixture.redis.getClients().publisher.get(issued.key);
    const original = parseWatchPairCapability(contents!);
    if (!original) throw new Error('Owned v2 capability absent');
    const replacement = JSON.stringify({ ...original, nonce: randomUUID() });
    const held = deferred(),
      release = deferred();
    const blocker = fixture.db.transaction(async (transaction) => {
      await transaction.execute(sql`LOCK TABLE users IN ACCESS EXCLUSIVE MODE`);
      held.release();
      await release.pending;
    });
    await held.pending;
    const pending = fixture.post('/api/watch/pair', { code: issued.code });
    try {
      await observeWait('Lock', 'users');
      await fixture.redis.getClients().publisher.set(issued.key, replacement, 'EX', 300);
    } finally {
      release.release();
      await blocker;
    }
    expect((await pending).status).toBe(401);
    expect(await fixture.redis.getClients().publisher.get(issued.key)).toBe(replacement);
  });

  it('consumes a v2 capability terminally if it expires during the real issuer user-row wait', async () => {
    const issued = await issueCode(await rawWeb({ authSessionId: randomUUID() }, 3));
    const held = deferred(),
      release = deferred();
    const blocker = fixture.db.transaction(async (transaction) => {
      await transaction.select().from(users).where(eq(users.id, userId)).for('update');
      held.release();
      await release.pending;
    });
    await held.pending;
    const pending = fixture.post('/api/watch/pair', { code: issued.code });
    try {
      await observeWait('Lock', 'for key share');
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, Date.parse(issued.expiresAt) - Date.now() + 30)));
    } finally {
      release.release();
      await blocker;
    }
    expect((await pending).status).toBe(401);
    expect(await fixture.redis.getClients().publisher.get(issued.key)).toBeNull();
    expect((await fixture.post('/api/watch/pair', { code: issued.code })).status).toBe(401);
  });

  it('keeps v2 readers compatible before emission switches and refuses unproven legacy pending codes in staged mode', async () => {
    const existing = await signIn();
    const issued = await issueCode(existing.jwt);
    vi.stubEnv('AUTH_WATCH_PAIRING_MODE', 'legacy');
    expect((await fixture.post('/api/watch/pair', { code: issued.code })).status).toBe(200);
    const { code: oldCode } = await legacyPendingCode();
    vi.stubEnv('AUTH_WATCH_PAIRING_MODE', 'source-bound-staging');
    expect((await fixture.post('/api/watch/pair', { code: oldCode })).status).toBe(401);
    expect((await fixture.post('/auth/native/refresh', { refreshToken: existing.refreshToken })).status).toBe(200);
  });

  it('keeps default legacy pairing compatible before a current manifest exists', async () => {
    const source = await signIn();
    vi.stubEnv('AUTH_WATCH_PAIRING_MODE', 'legacy');
    await fixture.db.update(authEmailProjection).set({ isCurrent: false });
    try {
      const issued = await issueCode(source.jwt);
      expect(await fixture.redis.getClients().publisher.get(issued.key)).toBe(userId);
      expect(decodeJwt((await pair(await fixture.post('/api/watch/pair', { code: issued.code }))).jwt)).toMatchObject({
        gen: 0,
        ngen: 0,
      });
    } finally {
      await fixture.db.update(authEmailProjection).set({ isCurrent: true });
    }
  });

  it('refuses legacy UID consumption and emission under an enforced manifest even if both local selectors are legacy', async () => {
    const source = await signIn();
    const old = await legacyPendingCode();
    vi.stubEnv('AUTH_WATCH_PAIRING_MODE', 'legacy');
    vi.stubEnv('AUTH_NATIVE_REVOCATION_MODE', 'legacy');
    expect((await fixture.post('/api/watch/pair', { code: old.code })).status).toBe(401);
    expect(await fixture.redis.getClients().publisher.get(old.key)).toBeNull();
    const unavailable = await fixture.post('/api/watch/pair-code', {}, source.jwt);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).not.toHaveProperty('code');
    expect((await fixture.post('/auth/native/refresh', { refreshToken: source.refreshToken })).status).toBe(200);
  });

  it.each(['reset', 'native-signout'] as const)(
    'retains the v2 floor during rollback after %s and allows a later fresh v2 handoff',
    async (cutoff) => {
      const source = await signIn();
      const old = await legacyPendingCode();
      if (cutoff === 'reset') expect((await resetPassword()).outcome).toBe('reset');
      else {
        vi.spyOn(revocation, 'currentNativeRevocationMode').mockReturnValue('generation');
        expect((await fixture.post('/auth/native/revoke', { refreshToken: source.refreshToken })).status).toBe(200);
      }
      const later = await signIn(cutoff === 'reset' ? nextPassword : password);
      await fixture.db.update(authEmailProjection).set({ phase: 'prepared' });
      vi.stubEnv('AUTH_WATCH_PAIRING_MODE', 'legacy');
      try {
        expect((await fixture.post('/api/watch/pair', { code: old.code })).status).toBe(401);
        expect((await fixture.post('/api/watch/pair-code', {}, later.jwt)).status).toBe(503);
        vi.stubEnv('AUTH_WATCH_PAIRING_MODE', 'source-bound-staging');
        const freshCode = await issueCode(later.jwt);
        const watch = await pair(await fixture.post('/api/watch/pair', { code: freshCode.code }));
        expect(decodeJwt(watch.jwt)).toMatchObject({
          gen: cutoff === 'reset' ? 1 : 0,
          ngen: cutoff === 'native-signout' ? 1 : 0,
        });
      } finally {
        await fixture.db.update(authEmailProjection).set({ phase: 'enforced' });
      }
    },
  );

  it('caps actual Redis TTL and public expiry at near-expiring signed source validity', async () => {
    const issued = await issueCode(await rawWeb({ authSessionId: randomUUID() }, 4));
    const capability = parseWatchPairCapability((await fixture.redis.getClients().publisher.get(issued.key))!);
    expect(capability).toBeTruthy();
    expect(Date.parse(issued.expiresAt)).toBe(capability!.expiresAt);
    expect(capability!.expiresAt).toBeLessThanOrEqual(capability!.source.expiresAt);
    expect(await fixture.redis.getClients().publisher.pttl(issued.key)).toBeLessThanOrEqual(4_000);
  });

  for (const release of recordings.releases) {
    it(`released token parser and real refresh accept opaque ancestry SID: ${release.tag}`, async () => {
      const exchanged = await pair(
        await fixture.post('/auth/native/exchange', { transferToken: transfer({ legacy_no_sid: true }) }),
      );
      expect(decodeJwt(exchanged.jwt).sid).toMatch(new RegExp(`^${UNKNOWN_WEB_NATIVE_SESSION_PREFIX}`));
      const client = await createReleasedClient(release, {
        fetch: async (input, init) => {
          const address = new URL(input instanceof Request ? input.url : input.toString());
          if (address.pathname === '/auth/native/credentials') return Response.json(exchanged);
          return fixture.network(input, init);
        },
      });
      expect(await callRecorded(client.auth, 'signInWithCredentials', email, password)).toMatchObject({
        success: true,
      });
      expect(await callRecorded(client.store, 'getAuthToken')).toBe(exchanged.jwt);
      const refreshed = await callRecorded(client.interceptor, 'deduplicatedRefresh');
      expect(
        typeof refreshed === 'boolean' ? refreshed : (refreshed as { status: string }).status === 'refreshed',
      ).toBe(true);
      expect(decodeJwt((await callRecorded(client.store, 'getAuthToken')) as string).sid).toBe(
        decodeJwt(exchanged.jwt).sid,
      );
    });
  }
});
