/**
 * #7596 B2a over real HTTP and PostgreSQL: how a bridged session meets login,
 * sign-out, the roll and the other non-login rows (`carried`). Revocation
 * always ends one row by its session id; nothing here cuts off an account.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { WEB_SESSION_COMMAND_PATHS, webSessionAccessReplySchema } from '@boardsesh/auth-protocol';
import { authSession, authSessionDenials, authSubjectCutoffs, mobileRefreshTokens } from '@boardsesh/db/schema';
import {
  bridge,
  canonical,
  climber,
  command,
  harnessDatabase,
  legacyCookie,
  login,
  nextAuthSecret,
  post,
  projectionId,
  rows,
  startHarness,
  stopHarness,
  stubCommandEnvironment,
} from './web-session-http-harness';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { revokeNativeCredentials } from '../native-revocation';
import { captureIdentityAuthority } from '../router';
import { replaceCanonicalAfterSecurityMutation } from '../security-session';
import { readFirstPartySession, requireFreshAuthentication } from '../session-reader';
import { CARRIED_WEB_SESSION_LINEAGE_PREFIX, issueWebSession } from '../web-session';

vi.mock('../../admission-pool', async () => {
  const { harnessDatabase: database } = await import('./web-session-http-harness');
  return {
    readOnAdmissionConnection: async (
      mark: () => void,
      read: (handle: ReturnType<typeof database>) => PromiseLike<unknown>,
    ) => {
      mark();
      return read(database());
    },
  };
});

beforeAll(() => startHarness());
beforeEach(stubCommandEnvironment);
afterAll(stopHarness);

const readStatus = async (token: string) =>
  (await post(WEB_SESSION_COMMAND_PATHS.session, command('session', { presented: canonical(token) }))).status;
const legacyStatus = async (credential: string) =>
  (await readFirstPartySession(harnessDatabase(), { kind: 'legacy-jwe', credential, secret: nextAuthSecret })).status;

async function bridged(credential: string) {
  const reply = await bridge(credential);
  if (reply.outcome !== 'bridged') throw new Error(`Synthetic bridge answered ${reply.outcome}`);
  return reply;
}

function signOut(presented: Record<string, unknown>, expectedUserId: string, expectedAuthSessionId: string) {
  return post(
    WEB_SESSION_COMMAND_PATHS.signout,
    command('signout', { ...presented, expectedUserId, expectedAuthSessionId }),
  );
}

async function carriedSession(userId: string, authenticatedAt = new Date(Date.now() - 60_000)) {
  const database = harnessDatabase();
  const authority = await database.transaction((transaction) =>
    captureIdentityAuthority(transaction, {
      expectedProjectionId: projectionId,
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
    }),
  );
  return database.transaction((transaction) =>
    issueWebSession(transaction, { userId, authority, now: new Date(), authenticatedAt, freshness: 'carried' }),
  );
}

describe('login and sign-out against a bridged session', () => {
  it('lets a login as B that presents A’s bridged token revoke it, and A’s cookie stays out', async () => {
    const [first, second] = [await climber(), await climber()];
    const credential = await legacyCookie(first.id, { claims: { authSessionId: randomUUID() } });
    const firstSession = await bridged(credential);
    const secondSession = await login(second.email, canonical(firstSession.token));
    expect(await readStatus(firstSession.token)).toBe(401);
    expect(await readStatus(secondSession.token)).toBe(200);
    expect((await bridge(credential)).outcome).toBe('denied');
    expect(await legacyStatus(credential)).toBe('denied');
    expect((await rows(first.id)).cutoffs).toEqual([]);
  });

  it('denies a bridge after that session id signed out, by its legacy cookie or its bridged token', async () => {
    const { id } = await climber();
    const viaCookie = randomUUID();
    const cookie = await legacyCookie(id, { claims: { authSessionId: viaCookie } });
    expect((await signOut({ presented: { kind: 'legacy-jwe', credential: cookie } }, id, viaCookie)).status).toBe(200);
    expect((await bridge(cookie)).outcome).toBe('denied');

    const viaToken = randomUUID();
    const tokenCookie = await legacyCookie(id, { claims: { authSessionId: viaToken } });
    const session = await bridged(tokenCookie);
    expect((await signOut({ presented: canonical(session.token) }, id, viaToken)).status).toBe(200);
    expect(await readStatus(session.token)).toBe(401);
    expect((await bridge(tokenCookie)).outcome).toBe('denied');
    // A renewed copy of the signed-out login is refused as well.
    const renewed = await legacyCookie(id, { claims: { authSessionId: viaToken }, lifetimeSeconds: 7200 });
    expect((await bridge(renewed)).outcome).toBe('denied');
    expect((await rows(id)).cutoffs).toEqual([]);
  });

  it('ends only the bridged row of a no-SID legacy cookie that signs out', async () => {
    const { id, email } = await climber();
    const leaving = await legacyCookie(id, { claims: { gen: 0 } });
    const staying = await legacyCookie(id, { claims: { gen: 0 }, lifetimeSeconds: 7200 });
    const [leavingSession, stayingSession] = [await bridged(leaving), await bridged(staying)];
    const loginSession = await login(email);
    const refreshTokenHash = randomUUID();
    await harnessDatabase()
      .insert(mobileRefreshTokens)
      .values({ userId: id, tokenHash: refreshTokenHash, expiresAt: new Date(Date.now() + 86_400_000) });
    const signedOut = await signOut(
      { presented: { kind: 'legacy-jwe', credential: leaving } },
      id,
      leavingSession.sessionId,
    );
    expect(signedOut.status).toBe(200);
    expect(await readStatus(leavingSession.token)).toBe(401);
    expect(await legacyStatus(leaving)).toBe('denied');
    expect((await bridge(leaving)).outcome).toBe('denied');
    // Nothing else ends: the other no-SID login, the password login, the phone.
    expect(await readStatus(stayingSession.token)).toBe(200);
    expect(await legacyStatus(staying)).toBe('admitted');
    expect(await readStatus(loginSession.token)).toBe(200);
    const after = await rows(id);
    expect(after.cutoffs).toEqual([]);
    const [phone] = await harnessDatabase()
      .select()
      .from(mobileRefreshTokens)
      .where(eq(mobileRefreshTokens.tokenHash, refreshTokenHash));
    expect(phone.revokedAt).toBeNull();
  });

  it('denies a never-bridged no-SID cookie that signs out, so a later bridge of it is refused (review Low 4)', async () => {
    const { id } = await climber();
    const cookie = await legacyCookie(id);
    const other = await bridged(await legacyCookie(id, { lifetimeSeconds: 7200 }));
    const read = await readFirstPartySession(harnessDatabase(), {
      kind: 'legacy-jwe',
      credential: cookie,
      secret: nextAuthSecret,
    });
    if (read.status !== 'admitted') throw new Error('Synthetic cookie refused');
    const before = await rows(id);
    const reply = await signOut(
      { presented: { kind: 'legacy-jwe', credential: cookie } },
      id,
      read.session.authSessionId,
    );
    expect(reply.status).toBe(200);
    const after = await rows(id);
    // One denial of this cookie's own id and nothing else: no cutoff, no other row.
    expect(after.denials.map((denial) => denial.sessionId)).toEqual([read.session.authSessionId]);
    expect({ ...after, denials: [] }).toEqual({ ...before, denials: [] });
    expect((await bridge(cookie)).outcome).toBe('denied');
    expect(await legacyStatus(cookie)).toBe('denied');
    expect(await readStatus(other.token)).toBe(200);
  });
});

describe('races and password changes against a bridged session', () => {
  it('ends the session whichever wins when a bridge races the sign-out of its cookie', async () => {
    const { id } = await climber();
    const sessionId = randomUUID();
    const cookie = await legacyCookie(id, { claims: { authSessionId: sessionId } });
    const [bridgeReply, signOutReply] = await Promise.all([
      bridge(cookie),
      signOut({ presented: { kind: 'legacy-jwe', credential: cookie } }, id, sessionId),
    ]);
    expect(signOutReply.status).toBe(200);
    const after = await rows(id);
    expect(after.sessions).toEqual([]);
    expect(after.denials.map((denial) => denial.sessionId)).toEqual([sessionId]);
    if (bridgeReply.outcome === 'bridged') expect(await readStatus(bridgeReply.token)).toBe(401);
    else expect(bridgeReply.outcome).toBe('denied');
    expect((await bridge(cookie)).outcome).toBe('denied');
  });

  it('ends a no-SID cookie whichever wins when a bridge races its sign-out, with no account cutoff', async () => {
    const { id } = await climber();
    const cookie = await legacyCookie(id);
    const read = await readFirstPartySession(harnessDatabase(), {
      kind: 'legacy-jwe',
      credential: cookie,
      secret: nextAuthSecret,
    });
    if (read.status !== 'admitted') throw new Error('Synthetic cookie refused');
    const sessionId = read.session.authSessionId;
    const [bridgeReply, signOutReply] = await Promise.all([
      bridge(cookie),
      signOut({ presented: { kind: 'legacy-jwe', credential: cookie } }, id, sessionId),
    ]);
    expect(signOutReply.status).toBe(200);
    const after = await rows(id);
    expect(after.sessions).toEqual([]);
    expect(after.cutoffs).toEqual([]);
    expect(after.denials.map((denial) => denial.sessionId)).toEqual([sessionId]);
    if (bridgeReply.outcome === 'bridged') expect(await readStatus(bridgeReply.token)).toBe(401);
    else expect(bridgeReply.outcome).toBe('denied');
    expect((await bridge(cookie)).outcome).toBe('denied');
  });

  it('keeps a password change final: the old token and both stamps of the cookie are refused', async () => {
    const { id } = await climber();
    const sessionId = randomUUID();
    const oldStamp = await legacyCookie(id, { claims: { authSessionId: sessionId, gen: 0 } });
    const session = await bridged(oldStamp);
    const database = harnessDatabase();
    const actor = await readFirstPartySession(database, { kind: 'canonical-token', token: session.token });
    if (actor.status !== 'admitted') throw new Error('Bridged session refused');
    const rotated = await database.transaction(async (transaction) => {
      await transaction
        .insert(authSubjectCutoffs)
        .values({ userId: id, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
      return replaceCanonicalAfterSecurityMutation(transaction, actor.session, 1);
    });
    if (!rotated) throw new Error('Bridged row not rotated');
    const [rowAfterChange] = await database.select().from(authSession).where(eq(authSession.id, sessionId));
    expect(await readStatus(session.token)).toBe(401);
    expect(await readStatus(rotated.token)).toBe(200);
    expect((await bridge(oldStamp)).outcome).toBe('denied');
    const newStamp = await legacyCookie(id, { claims: { authSessionId: sessionId, gen: 1 } });
    // The row now holds a random token, which the key does not derive: never re-keyed.
    expect((await bridge(newStamp)).outcome).toBe('denied');
    expect((await database.select().from(authSession).where(eq(authSession.id, sessionId)))[0]).toEqual(rowAfterChange);
  });

  it('lets a login presenting a no-SID bridged token, or its raw cookie, end that one row', async () => {
    const { id, email } = await climber();
    const [first, second, staying] = [
      await legacyCookie(id, { claims: { gen: 0 } }),
      await legacyCookie(id, { claims: { gen: 0 }, lifetimeSeconds: 7000 }),
      await legacyCookie(id, { claims: { gen: 0 }, lifetimeSeconds: 7200 }),
    ];
    const [firstSession, secondSession, stayingSession] = [
      await bridged(first),
      await bridged(second),
      await bridged(staying),
    ];
    const viaToken = await login(email, canonical(firstSession.token));
    const viaCookie = await login(email, { kind: 'legacy-jwe', credential: second });
    for (const ended of [firstSession, secondSession]) {
      expect(await readStatus(ended.token)).toBe(401);
      expect(
        await harnessDatabase()
          .select()
          .from(authSessionDenials)
          .where(eq(authSessionDenials.sessionId, ended.sessionId)),
      ).toHaveLength(1);
    }
    expect((await bridge(first)).outcome).toBe('denied');
    expect(await readStatus(stayingSession.token)).toBe(200);
    expect(await legacyStatus(staying)).toBe('admitted');
    expect(await readStatus(viaToken.token)).toBe(200);
    expect(await readStatus(viaCookie.token)).toBe(200);
    expect((await rows(id)).cutoffs).toEqual([]);
  });
});

describe('carried rows next to bridged ones', () => {
  it('keeps a carried row through a phone sign-out and ends it on its own sign-out', async () => {
    const { id } = await climber();
    const carried = await carriedSession(id);
    const [row] = await harnessDatabase().select().from(authSession).where(eq(authSession.id, carried.sessionId));
    expect(row.legacyLineageId).toBe(`${CARRIED_WEB_SESSION_LINEAGE_PREFIX}${carried.sessionId}`);
    const refreshTokenHash = randomUUID();
    await harnessDatabase()
      .insert(mobileRefreshTokens)
      .values({ userId: id, tokenHash: refreshTokenHash, expiresAt: new Date(Date.now() + 86_400_000) });
    expect(await revokeNativeCredentials(harnessDatabase(), refreshTokenHash, 'generation')).toBe(true);
    expect(await readStatus(carried.token)).toBe(200);
    expect((await signOut({ presented: canonical(carried.token) }, id, carried.sessionId)).status).toBe(200);
    expect(await readStatus(carried.token)).toBe(401);
  });

  it('keeps a carried row never fresh after a password change rotates its token', async () => {
    const { id } = await climber();
    const carried = await carriedSession(id, new Date(Date.now() - 30_000));
    const database = harnessDatabase();
    const before = await readFirstPartySession(database, { kind: 'canonical-token', token: carried.token });
    if (before.status !== 'admitted') throw new Error('Carried session refused');
    expect(requireFreshAuthentication(before.session)).toBe(false);
    const rotated = await database.transaction(async (transaction) => {
      await transaction
        .insert(authSubjectCutoffs)
        .values({ userId: id, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
      return replaceCanonicalAfterSecurityMutation(transaction, before.session, 1);
    });
    if (!rotated) throw new Error('Carried row not rotated');
    const after = await readFirstPartySession(database, { kind: 'canonical-token', token: rotated.token });
    if (after.status !== 'admitted') throw new Error('Rotated carried session refused');
    expect(after.session).toMatchObject({ source: 'bridge', generation: 1 });
    expect(requireFreshAuthentication(after.session)).toBe(false);
  });

  it('rolls a bridged row and a carried row of one account alike, and bridges only the bridged one', async () => {
    const { id } = await climber();
    const carried = await carriedSession(id);
    const bridgedCookie = await legacyCookie(id, { claims: { authSessionId: randomUUID() } });
    const bridgedSession = await bridged(bridgedCookie);
    // Due for a roll: under 29 days left on both.
    await harnessDatabase()
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() + 2 * 86_400_000) })
      .where(eq(authSession.id, carried.sessionId));
    for (const token of [carried.token, bridgedSession.token]) {
      const reply = webSessionAccessReplySchema.parse(
        (await post(WEB_SESSION_COMMAND_PATHS.access, command('access', { presented: canonical(token) }))).body,
      );
      expect(reply).toMatchObject({ outcome: 'active', rolled: true });
    }
    expect((await bridged(bridgedCookie)).token).toBe(bridgedSession.token);
    const carriedCookie = await legacyCookie(id, { claims: { authSessionId: carried.sessionId } });
    expect((await bridge(carriedCookie)).outcome).toBe('denied');
  });
});
