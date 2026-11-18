import { readFileSync } from 'node:fs';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import type { ProviderSecurityActor } from '@boardsesh/auth-protocol';
import {
  authEmailReservationMembers,
  authEmailReservations,
  authFirstPasswordChallenges,
  authSession,
  authSubjectCutoffs,
  users,
} from '@boardsesh/db/schema/auth';
import { createProviderSecurityEnvironment } from './provider-security-fixture';
import { captureFirstPasswordRuntime } from '../first-password-policy';
import { withFirstPasswordAuthority } from '../first-password-context';
import {
  firstPasswordTokenHash,
  readFirstPasswordChallenge,
  requestFirstPasswordChallenge,
} from '../first-password-challenges';
import {
  acknowledgeFirstPasswordResult,
  finalizeFirstPasswordChallenge,
  prepareFirstPasswordChallenge,
} from '../first-password-finalizer';
import { bindIdentityAuthority } from '../identity-authority';
import { providerWebSessionHash } from '../provider-security-context';
import { readFirstPartySession } from '../session-reader';
import { readLockedWebSubjectState } from '../../current-store/web-credential-state';
import { rollWebSession, signOutWebSession } from '../web-session';
import { captureIdentityAuthority } from '../router';
import { normalizeAccountEmail } from '../../normalize-email';
import { recordFunctionLevelIdentityMirrorForTests } from '../mirror-activation';

// #7596 B5c2: first password keyed by the first-party web session. No browser
// binding or intent remains, so the session token alone ties every step,
// including the one that completes the emailed link, to the session that asked.
recordFunctionLevelIdentityMirrorForTests();

let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
// The real sign-out reads the account through the admission pool; point it at this suite's database.
vi.mock('../../admission-pool', () => ({
  readOnAdmissionConnection: async (
    mark: () => void,
    read: (database: typeof environment.database) => PromiseLike<unknown>,
  ) => {
    mark();
    return read(environment.database);
  },
}));
type Owner = Awaited<ReturnType<typeof environment.actor>>;
const password = 'new Apple-only password 7596';
const runtime = () =>
  captureFirstPasswordRuntime({
    qualification: environment.runtime.qualification,
    legacySecret: environment.runtime.legacySecret,
    emailBindingKey: 'owned-first-password-private-rpc-key-7596',
  });

/** An Apple-only account that owns its email reservation: eligible for a first password. */
async function eligible() {
  const owner = await environment.actor('better-auth', 'canonical-token', { password: false, provider: 'apple' });
  const [user] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
  const normalizedEmail = normalizeAccountEmail(user.email);
  await environment.database.insert(authEmailReservations).values({
    normalizedEmail,
    basisProjectionId: environment.runtime.qualification.expectedProjectionId,
    state: 'owned',
    ownerUserId: owner.userId,
  });
  await environment.database.insert(authEmailReservationMembers).values({ normalizedEmail, userId: owner.userId });
  return owner;
}
async function requested(owner: Owner) {
  const issued = await requestFirstPasswordChallenge(environment.database, runtime(), { actor: owner.webActor });
  return { ...issued, actor: owner.webActor };
}
async function prepared(owner: Owner) {
  const issued = await requested(owner);
  const reply = await prepareFirstPasswordChallenge(environment.database, runtime(), {
    ...issued,
    confirmationToken: issued.mailPlan.token,
    password,
    confirmPassword: password,
  });
  return { ...issued, ...reply };
}
async function passwordOf(userId: string) {
  return withFirstPasswordAuthority(environment.database, runtime(), (transaction, authority) =>
    bindIdentityAuthority(transaction, authority).readPassword(userId),
  );
}
async function admit(owner: Owner) {
  return environment.database.transaction((transaction) =>
    readFirstPartySession(transaction, owner.credential, new Date(), (userId) =>
      readLockedWebSubjectState(transaction, userId),
    ),
  );
}
async function snapshot(challengeToken: string, userIds: readonly string[]) {
  return {
    challenge: await environment.database
      .select()
      .from(authFirstPasswordChallenges)
      .where(eq(authFirstPasswordChallenges.challengeHash, firstPasswordTokenHash('challenge', challengeToken))),
    cutoffs: await environment.database
      .select()
      .from(authSubjectCutoffs)
      .where(inArray(authSubjectCutoffs.userId, [...userIds])),
    sessions: await environment.database
      .select()
      .from(authSession)
      .where(inArray(authSession.userId, [...userIds])),
    users: await environment.database
      .select()
      .from(users)
      .where(inArray(users.id, [...userIds])),
    passwords: await Promise.all(userIds.map(passwordOf)),
  };
}

/** Another live session presents the owner's challenge, confirmation and preparation tokens. */
async function driveWithOtherSession(owner: Owner, other: ProviderSecurityActor, userIds: readonly string[]) {
  const issued = await requested(owner);
  const stolen = { actor: other, challengeToken: issued.challengeToken };
  let before = await snapshot(issued.challengeToken, userIds);
  await expect(readFirstPasswordChallenge(environment.database, runtime(), stolen)).rejects.toMatchObject({
    outcome: 'identity_changed',
  });
  // The emailed link must be completed by the session that asked for it.
  await expect(
    prepareFirstPasswordChallenge(environment.database, runtime(), {
      ...stolen,
      confirmationToken: issued.mailPlan.token,
      password,
      confirmPassword: password,
    }),
  ).rejects.toMatchObject({ outcome: 'identity_changed' });
  expect(await snapshot(issued.challengeToken, userIds)).toEqual(before);
  const preparation = await prepareFirstPasswordChallenge(environment.database, runtime(), {
    ...issued,
    confirmationToken: issued.mailPlan.token,
    password,
    confirmPassword: password,
  });
  before = await snapshot(issued.challengeToken, userIds);
  await expect(
    finalizeFirstPasswordChallenge(environment.database, runtime(), {
      ...stolen,
      preparationToken: preparation.preparationToken,
    }),
  ).rejects.toMatchObject({ outcome: 'identity_changed' });
  const recovery = { ...stolen, preparationToken: preparation.preparationToken, recoveryToken: issued.recoveryToken };
  await expect(acknowledgeFirstPasswordResult(environment.database, runtime(), recovery)).rejects.toMatchObject({
    outcome: 'denied',
    code: 'invalid_proof',
  });
  expect(await snapshot(issued.challengeToken, userIds)).toEqual(before);
  // The owner's own session still finishes; the other session still cannot ACK it.
  expect(
    await finalizeFirstPasswordChallenge(environment.database, runtime(), {
      ...issued,
      preparationToken: preparation.preparationToken,
    }),
  ).toEqual({ outcome: 'committed', generation: 1 });
  await expect(acknowledgeFirstPasswordResult(environment.database, runtime(), recovery)).rejects.toMatchObject({
    outcome: 'denied',
  });
}

describe('first password keyed by the first-party web session (#7596 B5c2)', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
    await environment.client.unsafe(
      readFileSync(new URL('../../../../../db/drizzle/0314_first_password_challenges.sql', import.meta.url), 'utf8'),
    );
  });
  afterAll(async () => environment?.close());

  it('stores the prefixed session hash and the token hash, never a binding', async () => {
    const owner = await eligible();
    const issued = await requested(owner);
    const [row] = (await snapshot(issued.challengeToken, [owner.userId])).challenge;
    expect(row).toMatchObject({
      actorSessionId: owner.sid,
      actorGeneration: 0,
      actorCredentialKind: 'canonical-token',
      browserBindingHash: providerWebSessionHash(owner.sid),
      browserVersion: 0,
      browserBindingExpiresAt: owner.sourceExpiresAt,
    });
  });

  it("another eligible account's live session cannot read, confirm, finalize or ACK this account's challenge", async () => {
    const owner = await eligible();
    const other = await eligible();
    await driveWithOtherSession(owner, other.webActor, [owner.userId, other.userId]);
    expect(await passwordOf(other.userId)).toBeNull();
    expect(
      await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, other.userId)),
    ).toHaveLength(0);
  });

  it('a second live session of the same account cannot complete the link the first one asked for', async () => {
    const owner = await eligible();
    const other = await environment.secondSession(owner);
    await driveWithOtherSession(owner, other.webActor, [owner.userId]);
    // Setting the password ended the other session.
    expect(
      (
        await environment.database.select().from(authSession).where(eq(authSession.id, other.sessionId))
      )[0].expiresAt.getTime(),
    ).toBeLessThanOrEqual(Date.now());
  });

  it('a finished challenge cannot be finalized, prepared or requested again, and writes nothing', async () => {
    const owner = await eligible();
    const command = await prepared(owner);
    expect(await finalizeFirstPasswordChallenge(environment.database, runtime(), command)).toEqual({
      outcome: 'committed',
      generation: 1,
    });
    const after = await snapshot(command.challengeToken, [owner.userId]);
    await expect(finalizeFirstPasswordChallenge(environment.database, runtime(), command)).rejects.toMatchObject({
      outcome: 'denied',
      code: 'already_set',
    });
    await expect(
      prepareFirstPasswordChallenge(environment.database, runtime(), {
        ...command,
        confirmationToken: command.mailPlan.token,
        password,
        confirmPassword: password,
      }),
    ).rejects.toMatchObject({ outcome: 'denied', code: 'already_set' });
    await expect(
      requestFirstPasswordChallenge(environment.database, runtime(), { actor: owner.webActor }),
    ).rejects.toMatchObject({ outcome: 'denied', code: 'already_set' });
    expect(await snapshot(command.challengeToken, [owner.userId])).toEqual(after);
  });

  it('a roll between prepare and finalize does not break the flow, and finalize keeps the rolled expiry', async () => {
    const owner = await eligible();
    const command = await prepared(owner);
    const roll = await rollWebSession(environment.database, owner.sid, new Date());
    if (!roll.rolled) throw new Error('The session did not roll');
    expect(await finalizeFirstPasswordChallenge(environment.database, runtime(), command)).toEqual({
      outcome: 'committed',
      generation: 1,
    });
    expect(await admit(owner)).toMatchObject({
      status: 'admitted',
      session: { generation: 1, expiresAt: roll.expiresAt, authenticatedAt: owner.authenticatedAt },
    });
  });

  it('a session signed out between prepare and finalize fails closed and sets no password', async () => {
    const owner = await eligible();
    const command = await prepared(owner);
    const authority = await environment.database.transaction((transaction) =>
      captureIdentityAuthority(transaction, environment.qualification),
    );
    expect(
      await signOutWebSession(
        environment.database,
        { credential: owner.credential, expectedUserId: owner.userId, expectedAuthSessionId: owner.sid },
        { ...environment.qualification, expectedWriterEpoch: authority.epoch },
      ),
    ).toBe('signed-out');
    const before = await snapshot(command.challengeToken, [owner.userId]);
    await expect(finalizeFirstPasswordChallenge(environment.database, runtime(), command)).rejects.toMatchObject({
      outcome: 'unauthenticated',
      code: 'invalid_proof',
    });
    expect(await snapshot(command.challengeToken, [owner.userId])).toEqual(before);
    expect(await passwordOf(owner.userId)).toBeNull();
    expect(before.challenge[0].phase).toBe('prepared');
  });
});
