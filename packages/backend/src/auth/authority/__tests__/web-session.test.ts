import { randomUUID } from 'node:crypto';
import { hkdf } from '@panva/hkdf';
import { EncryptJWT } from 'jose';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { isSignInGoodForPartnerAppChange, isSignInGoodForPartnerConsent } from '@boardsesh/auth-protocol/auth-time';
import * as schema from '@boardsesh/db/schema';
import {
  authCredentialLineage,
  authEmailProjection,
  authSession,
  authSessionDenials,
  authSubjectCutoffs,
  users,
} from '@boardsesh/db/schema';
import { createEnvironment, testBridgeTokenKey } from './environment';
import { bounded, connectAs, parkBeforeCommit } from './lock-order-harness';
import { bridgeLegacyCredential } from '../bridge';
import { denyFirstPartySession } from '../lineage';
import { sessionTokenDigest } from '../session-token';
import { captureIdentityAuthority, switchIdentityAuthority } from '../router';
import {
  readFirstPartySession,
  requireFreshAuthentication,
  webSignInProof,
  type FirstPartyCredential,
  type FirstPartySession,
} from '../session-reader';
import {
  issueWebSession,
  rollWebSession,
  WEB_SESSION_LIFETIME_SECONDS,
  WEB_SESSION_ROLL_BELOW_REMAINING_SECONDS,
  type WebSessionIssue,
} from '../web-session';
import { AuthSubjectDeniedError } from '../../human-admission';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';

const secret = 'synthetic-web-session-legacy-secret-6975';
const projectionId = 'web-session-projection';
const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date(Math.floor(Date.now() / 1000) * 1000);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
vi.mock('../../admission-pool', () => ({
  readOnAdmissionConnection: async (
    mark: () => void,
    read: (database: typeof environment.database) => PromiseLike<unknown>,
  ) => {
    mark();
    return read(environment.database);
  },
}));

beforeAll(async () => {
  environment = await createEnvironment();
  await environment.database.insert(authEmailProjection).values({
    projectionId,
    normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
    writerEpoch: 1,
    phase: 'enforced',
    preparedAt: now,
  });
});
afterAll(async () => environment?.close());

async function account(): Promise<string> {
  const userId = randomUUID();
  await environment.database.insert(users).values({ id: userId, email: `web-session-${userId}@example.test` });
  return userId;
}
function receipt() {
  return environment.database.transaction((transaction) =>
    captureIdentityAuthority(transaction, {
      expectedProjectionId: projectionId,
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
    }),
  );
}
async function issue(input: Omit<WebSessionIssue, 'authority' | 'now' | 'authenticatedAt'> & { at?: Date }) {
  const authority = await receipt();
  const at = input.at ?? now;
  return environment.database.transaction((transaction) =>
    issueWebSession(transaction, { ...input, authority, now: at, authenticatedAt: at }),
  );
}
async function read(credential: FirstPartyCredential, at = now) {
  return readFirstPartySession(environment.database, credential, at);
}
async function admitted(credential: FirstPartyCredential, at = now): Promise<FirstPartySession> {
  const outcome = await read(credential, at);
  if (outcome.status !== 'admitted') throw new Error(`Synthetic session ${outcome.status}`);
  return outcome.session;
}
const canonical = (token: string): FirstPartyCredential => ({ kind: 'canonical-token', token });
async function legacyCookie(userId: string, claims: Record<string, unknown>, lifetimeSeconds = 3600) {
  const key = await hkdf('sha256', new TextEncoder().encode(secret), '', 'NextAuth.js Generated Encryption Key', 32);
  return new EncryptJWT(claims)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setSubject(userId)
    .setIssuedAt(now.getTime() / 1000)
    .setExpirationTime(now.getTime() / 1000 + lifetimeSeconds)
    .encrypt(key);
}
async function sessionRow(sessionId: string) {
  const [row] = await environment.database.select().from(authSession).where(eq(authSession.id, sessionId));
  return row;
}

describe('issueWebSession', () => {
  it('writes a login row the session reader admits, fresh for five minutes only', async () => {
    const userId = await account();
    const issued = await issue({ userId });
    expect(issued.expiresAt.getTime()).toBe(now.getTime() + WEB_SESSION_LIFETIME_SECONDS * 1000);
    expect(issued.generation).toBe(0);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await sessionRow(issued.sessionId);
    // The row stores the token's digest, as every first-party writer does, never the token.
    expect(row).toMatchObject({
      userId,
      token: sessionTokenDigest(issued.token),
      legacyLineageId: null,
      revocationGeneration: 0,
    });
    expect((await read(canonical(row.token))).status).toBe('denied');
    expect(row.originalAuthenticatedAt).toEqual(now);
    const session = await admitted(canonical(issued.token));
    expect(session).toMatchObject({
      userId,
      authSessionId: issued.sessionId,
      generation: 0,
      source: 'login',
      linkGuarded: true,
      requiresAccountCutoff: false,
    });
    expect(session.authenticatedAt).toEqual(now);
    expect(requireFreshAuthentication(session, new Date(now.getTime() + 299_000))).toBe(true);
    expect(requireFreshAuthentication(session, new Date(now.getTime() + 301_000))).toBe(false);
  });

  it('stamps the account generation it reads under the user lock', async () => {
    const userId = await account();
    await environment.database
      .insert(authSubjectCutoffs)
      .values({ userId, generation: 2, revokedThrough: now, lastOperationId: randomUUID() });
    const issued = await issue({ userId });
    expect(issued.generation).toBe(2);
    expect((await admitted(canonical(issued.token))).generation).toBe(2);
  });

  it('refuses a missing or deleted account and writes nothing', async () => {
    const deleted = await account();
    await environment.database
      .insert(authSubjectCutoffs)
      .values({ userId: deleted, generation: 1, revokedThrough: now, deletedAt: now, lastOperationId: randomUUID() });
    for (const userId of [randomUUID(), deleted]) {
      await expect(issue({ userId })).rejects.toBeInstanceOf(AuthSubjectDeniedError);
      expect(await environment.database.select().from(authSession).where(eq(authSession.userId, userId))).toEqual([]);
    }
  });

  it('refuses a sign-in time later than now', async () => {
    const userId = await account();
    const authority = await receipt();
    await expect(
      environment.database.transaction((transaction) =>
        issueWebSession(transaction, { userId, authority, now, authenticatedAt: new Date(now.getTime() + 1000) }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
  });

  it('refuses a moved authority and leaves the presented session live', async () => {
    const userId = await account();
    const presented = await issue({ userId });
    const stale = await receipt();
    for (const [from, to] of [
      ['current-store', 'better-auth'],
      ['better-auth', 'current-store'],
    ] as const)
      await environment.database.transaction(async (transaction) => {
        const [manifest] = await transaction.select().from(authEmailProjection);
        await switchIdentityAuthority(transaction, { projectionId, epoch: manifest.writerEpoch, from, to });
      });
    const presentedSession = await admitted(canonical(presented.token));
    await expect(
      environment.database.transaction((transaction) =>
        issueWebSession(transaction, {
          userId,
          presented: presentedSession,
          authority: stale,
          now,
          authenticatedAt: now,
        }),
      ),
    ).rejects.toMatchObject({ code: 'STALE_AUTHORITY' });
    expect((await read(canonical(presented.token))).status).toBe('admitted');
    expect(await environment.database.select().from(authSession).where(eq(authSession.userId, userId))).toHaveLength(1);
  });

  it('revokes the presented session in the same transaction: a reader never sees both or neither', async () => {
    const [first, second] = [await account(), await account()];
    const presented = await issue({ userId: first });
    const presentedSession = await admitted(canonical(presented.token));
    const client = connectAs(environment.client.options.database, 'web-session-issuer');
    const issuerDatabase = drizzle(client, { schema });
    try {
      const authority = await receipt();
      const parked = parkBeforeCommit(issuerDatabase, () => true);
      let pendingToken = '';
      const login = issuerDatabase.transaction(async (transaction) => {
        const issued = await issueWebSession(transaction, {
          userId: second,
          presented: presentedSession,
          authority,
          now,
          authenticatedAt: now,
        });
        pendingToken = issued.token;
        return issued;
      });
      try {
        await bounded(parked.reached);
        // Before COMMIT, the old session still works and the new one does not exist.
        expect((await read(canonical(presented.token))).status).toBe('admitted');
        expect((await read(canonical(pendingToken))).status).toBe('denied');
      } finally {
        parked.release();
      }
      const issued = await bounded(login);
      expect((await read(canonical(presented.token))).status).toBe('denied');
      expect((await admitted(canonical(issued.token))).userId).toBe(second);
      const [denial] = await environment.database
        .select()
        .from(authSessionDenials)
        .where(eq(authSessionDenials.sessionId, presented.sessionId));
      expect(denial.userId).toBe(first);
      expect(await sessionRow(presented.sessionId)).toBeUndefined();
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it('revokes a presented legacy cookie of another account through its SID', async () => {
    const [legacyOwner, signingIn] = [await account(), await account()];
    const sessionId = randomUUID();
    const cookie = await legacyCookie(legacyOwner, { authSessionId: sessionId });
    const legacy: FirstPartyCredential = { kind: 'legacy-jwe', credential: cookie, secret };
    const issued = await issue({ userId: signingIn, presented: await admitted(legacy) });
    expect((await read(legacy)).status).toBe('denied');
    expect(
      (await bridgeLegacyCredential(environment.database, cookie, secret, testBridgeTokenKey, 'on', now)).status,
    ).toBe('denied');
    expect((await admitted(canonical(issued.token))).userId).toBe(signingIn);
  });

  it('never cuts off an account: a presented no-SID cookie and its bridged row each end alone', async () => {
    const userId = await account();
    const cookie = await legacyCookie(userId, { legacy_no_sid: true });
    const legacy: FirstPartyCredential = { kind: 'legacy-jwe', credential: cookie, secret };
    const other = await issue({ userId });
    const bridgedCookie = await legacyCookie(userId, {});
    const bridged = await bridgeLegacyCredential(
      environment.database,
      bridgedCookie,
      secret,
      testBridgeTokenKey,
      'on',
      now,
    );
    if (bridged.status !== 'bridged') throw new Error('Synthetic bridge failed');
    const bridgedSession = await admitted(canonical(bridged.token));
    expect(bridgedSession.requiresAccountCutoff).toBe(true);
    for (const presented of [await admitted(legacy), bridgedSession]) {
      const issued = await issue({ userId, presented });
      expect(issued.generation).toBe(0);
      expect((await admitted(canonical(issued.token))).generation).toBe(0);
    }
    // Its own id is denied, nothing else (#7596 B2c): a later bridge of it is refused.
    expect((await read(legacy)).status).toBe('denied');
    // The bridged row is ended as itself: row gone, its id denied.
    expect((await read(canonical(bridged.token))).status).toBe('denied');
    expect(await sessionRow(bridged.session.id)).toBeUndefined();
    expect((await read({ kind: 'legacy-jwe', credential: bridgedCookie, secret })).status).toBe('denied');
    expect((await read(canonical(other.token))).status).toBe('admitted');
    expect(
      await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)),
    ).toEqual([]);
  });

  it('refuses a deleted account before revoking the presented session, even if the caller commits', async () => {
    const [presentedOwner, deleted] = [await account(), await account()];
    await environment.database
      .insert(authSubjectCutoffs)
      .values({ userId: deleted, generation: 1, revokedThrough: now, deletedAt: now, lastOperationId: randomUUID() });
    const presentedSession = await issue({ userId: presentedOwner });
    const presented = await admitted(canonical(presentedSession.token));
    const authority = await receipt();
    // A careless caller that swallows the refusal still commits nothing.
    const refusal = await environment.database.transaction(async (transaction) =>
      issueWebSession(transaction, { userId: deleted, presented, authority, now, authenticatedAt: now }).catch(
        (error: unknown) => error,
      ),
    );
    expect(refusal).toBeInstanceOf(AuthSubjectDeniedError);
    expect((await read(canonical(presentedSession.token))).status).toBe('admitted');
    expect(
      await environment.database
        .select()
        .from(authSessionDenials)
        .where(eq(authSessionDenials.sessionId, presentedSession.sessionId)),
    ).toEqual([]);
  });

  it('writes a carried session that keeps its sign-in time but is never fresh', async () => {
    const userId = await account();
    const signedInElsewhere = new Date(now.getTime() - 60_000);
    const authority = await receipt();
    const issued = await environment.database.transaction((transaction) =>
      issueWebSession(transaction, {
        userId,
        authority,
        now,
        authenticatedAt: signedInElsewhere,
        freshness: 'carried',
      }),
    );
    const session = await admitted(canonical(issued.token));
    expect(session).toMatchObject({
      source: 'bridge',
      authenticatedAt: signedInElsewhere,
      requiresAccountCutoff: false,
    });
    expect(requireFreshAuthentication(session, now)).toBe(false);
    expect(webSignInProof(session).authenticatedAtMs).toBeNull();
    // It rolls like any web row.
    const rollAt = new Date(now.getTime() + 2 * DAY_MS);
    expect((await rollWebSession(environment.database, issued.sessionId, rollAt)).rolled).toBe(true);
    // And an unknown freshness is refused.
    await expect(
      environment.database.transaction((transaction) =>
        issueWebSession(transaction, {
          userId,
          authority,
          now,
          authenticatedAt: now,
          freshness: 'fresh' as unknown as 'login',
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
  });
});

describe('rollWebSession', () => {
  const at = (days: number, extraMs = 0) => new Date(now.getTime() + days * DAY_MS + extraMs);

  it('rolls only once fewer than 29 days remain, to 30 days from the roll', async () => {
    const issued = await issue({ userId: await account() });
    expect(WEB_SESSION_ROLL_BELOW_REMAINING_SECONDS).toBe(29 * 24 * 60 * 60);
    expect(await rollWebSession(environment.database, issued.sessionId, at(0.5))).toEqual({ rolled: false });
    expect(await rollWebSession(environment.database, issued.sessionId, at(1))).toEqual({ rolled: false });
    const rolledAt = at(1, 1);
    expect(await rollWebSession(environment.database, issued.sessionId, rolledAt)).toEqual({
      rolled: true,
      expiresAt: at(31, 1),
    });
    expect((await sessionRow(issued.sessionId)).expiresAt).toEqual(at(31, 1));
    expect((await sessionRow(issued.sessionId)).originalAuthenticatedAt).toEqual(now);
    // Past the first expiry, the rolled session still reads.
    expect((await read(canonical(issued.token), at(30, 1000))).status).toBe('admitted');
  });

  it('never rolls an expired, denied, cut-off or deleted session', async () => {
    const expired = await issue({ userId: await account() });
    expect(await rollWebSession(environment.database, expired.sessionId, at(30))).toEqual({ rolled: false });

    const signedOut = await issue({ userId: await account() });
    await denyFirstPartySession(environment.database, await admitted(canonical(signedOut.token)), now);
    expect(await rollWebSession(environment.database, signedOut.sessionId, at(2))).toEqual({ rolled: false });

    // A denial row alone, the row itself still present.
    const denied = await issue({ userId: await account() });
    const deniedRow = await sessionRow(denied.sessionId);
    await environment.database
      .insert(authSessionDenials)
      .values({ sessionId: denied.sessionId, userId: deniedRow.userId, expiresAt: at(40) });
    expect(await rollWebSession(environment.database, denied.sessionId, at(2))).toEqual({ rolled: false });

    // A reset or account sign-out moved the generation after issuance.
    const cutOffUser = await account();
    const cutOff = await issue({ userId: cutOffUser });
    await environment.database
      .insert(authSubjectCutoffs)
      .values({ userId: cutOffUser, generation: 1, revokedThrough: now, lastOperationId: randomUUID() });
    expect(await rollWebSession(environment.database, cutOff.sessionId, at(2))).toEqual({ rolled: false });

    const deletedUser = await account();
    const deleted = await issue({ userId: deletedUser });
    await environment.database.insert(authSubjectCutoffs).values({
      userId: deletedUser,
      generation: 0,
      revokedThrough: now,
      deletedAt: now,
      lastOperationId: randomUUID(),
    });
    expect(await rollWebSession(environment.database, deleted.sessionId, at(2))).toEqual({ rolled: false });

    expect(await rollWebSession(environment.database, randomUUID(), at(2))).toEqual({ rolled: false });
  });

  it('rolls a bridged web row past its legacy expiry until its lineage is revoked', async () => {
    const userId = await account();
    // A legacy cookie with ten days left: the bridge caps the row at that expiry.
    const cookie = await legacyCookie(userId, { authSessionId: randomUUID() }, 10 * 24 * 60 * 60);
    const bridged = await bridgeLegacyCredential(environment.database, cookie, secret, testBridgeTokenKey, 'on', now);
    if (bridged.status !== 'bridged') throw new Error('Synthetic bridge refused');
    expect(bridged.session.expiresAt).toEqual(at(10));
    expect(await rollWebSession(environment.database, bridged.session.id, at(1))).toEqual({
      rolled: true,
      expiresAt: at(31),
    });
    expect((await read(canonical(bridged.token), at(20))).status).toBe('admitted');
    // Re-bridging the same cookie keeps the rolled expiry.
    await bridgeLegacyCredential(environment.database, cookie, secret, testBridgeTokenKey, 'on', at(2));
    expect((await sessionRow(bridged.session.id)).expiresAt).toEqual(at(31));
    await environment.database
      .update(authCredentialLineage)
      .set({ revokedAt: now })
      .where(eq(authCredentialLineage.id, bridged.session.legacyLineageId!));
    expect(await rollWebSession(environment.database, bridged.session.id, at(5))).toEqual({ rolled: false });
  });

  it('never rolls a row bound to a native refresh token', async () => {
    const userId = await account();
    for (const lineage of ['native-refresh:', 'credential:native-refresh:']) {
      const id = randomUUID();
      await environment.database.insert(authSession).values({
        id,
        token: randomUUID(),
        userId,
        expiresAt: at(3),
        createdAt: now,
        updatedAt: now,
        legacyLineageId: `${lineage}${id}`,
        revocationGeneration: 0,
      });
      expect(await rollWebSession(environment.database, id, now)).toEqual({ rolled: false });
    }
  });
});

describe('session source', () => {
  function consent(session: FirstPartySession, at: Date) {
    const signIn = webSignInProof(session);
    return {
      // The 30-day rule reads the session's own sign-in time, whatever its source.
      thirtyDays: isSignInGoodForPartnerConsent(
        {
          authTimeSeconds: session.authenticatedAt ? Math.floor(session.authenticatedAt.getTime() / 1000) : null,
          linkGuarded: session.linkGuarded,
          passwordChangedAt: null,
        },
        at.getTime(),
      ),
      fiveMinutes: requireFreshAuthentication(session, at),
      partnerAppChange:
        signIn.authenticatedAtMs !== null &&
        isSignInGoodForPartnerAppChange(
          {
            authTimeSeconds: Math.floor(signIn.authenticatedAtMs / 1000),
            linkGuarded: signIn.linkGuarded,
            passwordChangedAt: null,
          },
          at.getTime(),
        ),
    };
  }

  it('a bridged session fails every five-minute check but keeps its sign-in time for the 30-day rule', async () => {
    const userId = await account();
    const signedInAt = new Date(now.getTime() - 10_000);
    const cookie = await legacyCookie(userId, {
      authSessionId: randomUUID(),
      auth_time: signedInAt.getTime() / 1000,
      link_guarded: true,
    });
    const bridged = await bridgeLegacyCredential(environment.database, cookie, secret, testBridgeTokenKey, 'on', now);
    if (bridged.status !== 'bridged') throw new Error('Synthetic bridge refused');
    const session = await admitted(canonical(bridged.token));
    expect(session.source).toBe('bridge');
    expect(session.authenticatedAt).toEqual(signedInAt);
    expect(webSignInProof(session)).toEqual({ authenticatedAtMs: null, linkGuarded: true });
    expect(consent(session, now)).toEqual({ thirtyDays: true, fiveMinutes: false, partnerAppChange: false });
  });

  it('a login-issued session passes both', async () => {
    const issued = await issue({ userId: await account() });
    const session = await admitted(canonical(issued.token));
    expect(consent(session, new Date(now.getTime() + 60_000))).toEqual({
      thirtyDays: true,
      fiveMinutes: true,
      partnerAppChange: true,
    });
  });

  it('a session without a source never counts as fresh', async () => {
    const issued = await issue({ userId: await account() });
    const unknown: FirstPartySession = { ...(await admitted(canonical(issued.token))), source: undefined };
    expect(requireFreshAuthentication(unknown, now)).toBe(false);
    expect(webSignInProof(unknown).authenticatedAtMs).toBeNull();
  });
});
