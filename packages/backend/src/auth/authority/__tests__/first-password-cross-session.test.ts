import { readFileSync } from 'node:fs';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import type { ProviderSecurityActor } from '@boardsesh/auth-protocol';
import {
  authCredentialLineage,
  authEmailReservationMembers,
  authEmailReservations,
  authEmailVerificationState,
  authEmailVerificationTokens,
  authFirstPasswordChallenges,
  authPasswordRecoveryState,
  authPasswordRecoveryTokens,
  authSession,
  authSubjectCutoffs,
  users,
} from '@boardsesh/db/schema/auth';
import { randomBytes, randomUUID } from 'node:crypto';
import { createProviderSecurityIntent, bindProviderSecurityFlow } from '../provider-security-intents';
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
async function eligible(source: 'login' | 'bridge' | 'carried' = 'login') {
  const owner = await environment.actor('better-auth', 'canonical-token', {
    password: false,
    provider: 'apple',
    source,
  });
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

  it('finalize ends pending reset and verify links, other lineages and pending provider intents of the session', async () => {
    const owner = await eligible();
    const [user] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 1_800_000);
    const link = {
      userId: owner.userId,
      deliveredEmail: user.email,
      normalizedEmail: normalizeAccountEmail(user.email),
    };
    await environment.database
      .insert(authPasswordRecoveryState)
      .values({ userId: owner.userId, purpose: 'password-reset', generation: 1 });
    const resetHash = randomBytes(32).toString('hex');
    await environment.database.insert(authPasswordRecoveryTokens).values({
      ...link,
      tokenHash: resetHash,
      purpose: 'password-reset',
      subjectGeneration: 0,
      issuanceGeneration: 1,
      issuedAt,
      expiresAt,
    });
    await environment.database
      .insert(authEmailVerificationState)
      .values({ userId: owner.userId, purpose: 'email-verification', generation: 1 });
    const verifyHash = randomBytes(32).toString('hex');
    await environment.database.insert(authEmailVerificationTokens).values({
      ...link,
      tokenHash: verifyHash,
      purpose: 'email-verification',
      subjectGeneration: 0,
      issuanceGeneration: 1,
      issuedAt,
      expiresAt,
    });
    const otherLineage = `session:${randomUUID()}`;
    await environment.database.insert(authCredentialLineage).values({
      id: otherLineage,
      userId: owner.userId,
      sessionId: randomUUID(),
      originalAuthenticatedAt: owner.authenticatedAt,
      originalExpiresAt: expiresAt,
    });
    // A provider link this same session started before setting the password.
    const pendingLink = await createProviderSecurityIntent(environment.database, environment.runtime, {
      actor: owner.webActor,
      action: 'link',
      provider: 'google',
      methodId: null,
    });
    const command = await prepared(owner);
    expect(await finalizeFirstPasswordChallenge(environment.database, runtime(), command)).toEqual({
      outcome: 'committed',
      generation: 1,
    });
    const [reset] = await environment.database
      .select()
      .from(authPasswordRecoveryTokens)
      .where(eq(authPasswordRecoveryTokens.tokenHash, resetHash));
    const [verify] = await environment.database
      .select()
      .from(authEmailVerificationTokens)
      .where(eq(authEmailVerificationTokens.tokenHash, verifyHash));
    expect(reset.supersededAt).toBeInstanceOf(Date);
    expect(verify.supersededAt).toBeInstanceOf(Date);
    expect(
      (
        await environment.database
          .select()
          .from(authPasswordRecoveryState)
          .where(eq(authPasswordRecoveryState.userId, owner.userId))
      )[0].generation,
    ).toBe(2);
    expect(
      (
        await environment.database
          .select()
          .from(authEmailVerificationState)
          .where(eq(authEmailVerificationState.userId, owner.userId))
      )[0].generation,
    ).toBe(2);
    const [lineage] = await environment.database
      .select()
      .from(authCredentialLineage)
      .where(eq(authCredentialLineage.id, otherLineage));
    expect(lineage.revokedAt).toBeInstanceOf(Date);
    // The intent was made at generation 0; the session is at 1 now.
    await expect(
      bindProviderSecurityFlow(environment.database, environment.runtime, {
        actor: owner.webActor,
        intentToken: pendingLink.intentToken,
        flowHash: randomBytes(32).toString('hex'),
      }),
    ).rejects.toMatchObject({ outcome: 'identity_changed' });
  });

  for (const source of ['bridge', 'carried'] as const)
    it(`a ${source} session sets the first password and keeps its source, token and lineage`, async () => {
      const owner = await eligible(source);
      const before = await admit(owner);
      expect(before).toMatchObject({ status: 'admitted', session: { source: 'bridge' } });
      const command = await prepared(owner);
      expect(await finalizeFirstPasswordChallenge(environment.database, runtime(), command)).toEqual({
        outcome: 'committed',
        generation: 1,
      });
      expect(await passwordOf(owner.userId)).not.toBeNull();
      expect(await admit(owner)).toMatchObject({
        status: 'admitted',
        session: { source: 'bridge', generation: 1, authenticatedAt: owner.authenticatedAt },
      });
      const [row] = await environment.database.select().from(authSession).where(eq(authSession.id, owner.sid));
      expect(row.legacyLineageId).toBe(source === 'bridge' ? `session:${owner.sid}` : `carried:${owner.sid}`);
      if (source === 'bridge') {
        const [lineage] = await environment.database
          .select()
          .from(authCredentialLineage)
          .where(eq(authCredentialLineage.sessionId, owner.sid));
        expect(lineage.revokedAt).toBeNull();
      }
    });

  it('an account holds one live challenge: a second request ends the first', async () => {
    const owner = await eligible();
    const first = await requested(owner);
    const second = await requested(owner);
    const [ended] = (await snapshot(first.challengeToken, [owner.userId])).challenge;
    expect(ended).toMatchObject({ phase: 'terminal' });
    expect(
      await environment.database
        .select()
        .from(authFirstPasswordChallenges)
        .where(eq(authFirstPasswordChallenges.userId, owner.userId)),
    ).toHaveLength(2);
    await expect(
      prepareFirstPasswordChallenge(environment.database, runtime(), {
        ...first,
        confirmationToken: first.mailPlan.token,
        password,
        confirmPassword: password,
      }),
    ).rejects.toMatchObject({ outcome: 'denied', code: 'replayed' });
    expect((await snapshot(second.challengeToken, [owner.userId])).challenge[0].phase).toBe('pending');
  });
});
