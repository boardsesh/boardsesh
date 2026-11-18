/**
 * #7596 B2a over real HTTP and PostgreSQL: how a bridged session meets login,
 * sign-out, the roll and the other non-login rows (`carried`). Revocation
 * always ends one row by its session id; nothing here cuts off an account.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { WEB_SESSION_COMMAND_PATHS, webSessionRollReplySchema } from '@boardsesh/auth-protocol';
import { authSession, authSubjectCutoffs, mobileRefreshTokens } from '@boardsesh/db/schema';
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

beforeAll(startHarness);
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

  it('writes nothing when a no-SID legacy cookie that was never bridged signs out', async () => {
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
    expect(await rows(id)).toEqual(before);
    expect(await readStatus(other.token)).toBe(200);
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
      const reply = webSessionRollReplySchema.parse(
        (await post(WEB_SESSION_COMMAND_PATHS.roll, command('roll', { token }))).body,
      );
      expect(reply).toMatchObject({ outcome: 'active', rolled: true });
    }
    expect((await bridged(bridgedCookie)).token).toBe(bridgedSession.token);
    const carriedCookie = await legacyCookie(id, { claims: { authSessionId: carried.sessionId } });
    expect((await bridge(carriedCookie)).outcome).toBe('denied');
  });
});
