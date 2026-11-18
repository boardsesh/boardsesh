import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compare } from 'bcryptjs';
import postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  authEmailReservationMembers,
  authEmailReservations,
  authFirstPasswordChallenges,
  authProviderReauthenticationReceipts,
  authSecurityMutationEvents,
  authSession,
  authSubjectCutoffs,
  mobileRefreshTokens,
  oauthClient,
  oauthConnections,
  oauthRefreshToken,
  userCredentials,
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
import { readFirstPartySession, type FirstPartyCredential } from '../session-reader';
import { readLockedWebSubjectState } from '../../current-store/web-credential-state';
import { createProviderSecurityIntent } from '../provider-security-intents';
import { reauthenticateProviderWithPassword } from '../provider-security-reauthentication';
import { normalizeAccountEmail } from '../../normalize-email';
import { recordFunctionLevelIdentityMirrorForTests } from '../mirror-activation';

// These writers run with the mirror on and no backend boot (function-level mirror).
recordFunctionLevelIdentityMirrorForTests();

let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
type Owner = Awaited<ReturnType<typeof environment.actor>>;
const password = 'new Apple-only password 6975';
const runtime = () =>
  captureFirstPasswordRuntime({
    qualification: environment.runtime.qualification,
    legacySecret: environment.runtime.legacySecret,
    emailBindingKey: 'owned-first-password-private-rpc-key-6975',
  });

async function reserve(owner: Owner) {
  const [user] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
  const normalizedEmail = normalizeAccountEmail(user.email);
  await environment.database.insert(authEmailReservations).values({
    normalizedEmail,
    basisProjectionId: environment.runtime.qualification.expectedProjectionId,
    state: 'owned',
    ownerUserId: owner.userId,
  });
  await environment.database.insert(authEmailReservationMembers).values({ normalizedEmail, userId: owner.userId });
  return user.email;
}
async function stored(token: string) {
  const [challenge] = await environment.database
    .select()
    .from(authFirstPasswordChallenges)
    .where(eq(authFirstPasswordChallenges.challengeHash, firstPasswordTokenHash('challenge', token)));
  return challenge;
}
async function selectedPassword(userId: string) {
  return withFirstPasswordAuthority(environment.database, runtime(), (transaction, authority) =>
    bindIdentityAuthority(transaction, authority).readPassword(userId),
  );
}
async function partner(userId: string) {
  const clientId = randomUUID();
  const connectionId = randomUUID();
  await environment.database
    .insert(oauthClient)
    .values({ id: clientId, clientId, redirectUris: ['https://owned.example.test/callback'] });
  await environment.database
    .insert(oauthConnections)
    .values({ id: connectionId, userId, clientId, generation: 0, scopes: ['logbook:read'] });
  const tokenId = randomUUID();
  await environment.database.insert(oauthRefreshToken).values({
    id: tokenId,
    token: randomUUID(),
    userId,
    clientId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    scopes: ['logbook:read'],
  });
  return { connectionId, tokenId };
}
async function admit(credential: FirstPartyCredential) {
  return environment.database.transaction((transaction) =>
    readFirstPartySession(transaction, credential, new Date(), (userId) =>
      readLockedWebSubjectState(transaction, userId),
    ),
  );
}
async function setup(owner: Owner) {
  const recipient = await reserve(owner);
  const issued = await requestFirstPasswordChallenge(environment.database, runtime(), { actor: owner.webActor });
  return { ...issued, actor: owner.webActor, challengeToken: issued.challengeToken, recipient };
}
async function prepare(owner: Owner) {
  const issued = await setup(owner);
  const prepared = await prepareFirstPasswordChallenge(environment.database, runtime(), {
    ...issued,
    confirmationToken: issued.mailPlan.token,
    password,
    confirmPassword: password,
  });
  return { ...issued, ...prepared };
}
async function snapshot(owner: Owner, challengeToken: string) {
  return {
    password: await selectedPassword(owner.userId),
    user: await environment.database.select().from(users).where(eq(users.id, owner.userId)),
    challenge: await stored(challengeToken),
    cutoffs: await environment.database
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, owner.userId)),
    events: await environment.database
      .select()
      .from(authSecurityMutationEvents)
      .where(eq(authSecurityMutationEvents.userId, owner.userId)),
    sessions: await environment.database.select().from(authSession).where(eq(authSession.userId, owner.userId)),
    native: await environment.database
      .select()
      .from(mobileRefreshTokens)
      .where(eq(mobileRefreshTokens.userId, owner.userId)),
    partners: await environment.database
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.userId, owner.userId)),
    partnerTokens: await environment.database
      .select()
      .from(oauthRefreshToken)
      .where(eq(oauthRefreshToken.userId, owner.userId)),
  };
}
async function databaseMilliseconds() {
  const [clock] = await environment.client<
    { milliseconds: number }[]
  >`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::double precision AS milliseconds`;
  return clock.milliseconds;
}

describe('UID-bound first-password buffered finalization', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
    await environment.client.unsafe(
      readFileSync(new URL('../../../../../db/drizzle/0314_first_password_challenges.sql', import.meta.url), 'utf8'),
    );
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => environment?.close());

  for (const selected of ['current-store', 'better-auth'] as const) {
    for (const mirror of ['on', 'off'] as const) {
      it(`${selected}/mirror-${mirror}: sets the first password only after preparation and keeps this session and its token`, async () => {
        vi.stubEnv('AUTH_IDENTITY_MIRROR', mirror);
        const owner = await environment.actor(selected, 'canonical-token', {
          password: false,
          provider: 'apple',
          unknownAge: true,
        });
        const original = await admit(owner.credential);
        if (original.status !== 'admitted') throw new Error('Owned source did not admit');
        const [originalRow] = await environment.database
          .select()
          .from(authSession)
          .where(eq(authSession.id, owner.sid));
        const issued = await setup(owner);
        expect(issued.mailPlan).toMatchObject({ kind: 'uid-first-password-v1', recipient: issued.recipient });
        expect(await selectedPassword(owner.userId)).toBeNull();
        const pending = await stored(issued.challengeToken);
        const cutoff = await environment.database
          .select()
          .from(authSubjectCutoffs)
          .where(eq(authSubjectCutoffs.userId, owner.userId));
        expect(cutoff).toHaveLength(0);
        expect(pending).toMatchObject({
          phase: 'pending',
          pendingPasswordHash: null,
          consumedAt: null,
          browserVersion: 0,
        });
        const beforeRead = JSON.stringify(pending);
        expect(await readFirstPasswordChallenge(environment.database, runtime(), issued)).toMatchObject({
          outcome: 'pending',
        });
        expect(JSON.stringify(await stored(issued.challengeToken))).toBe(beforeRead);
        const encodedPending = JSON.stringify(pending);
        for (const secret of [
          issued.recipient,
          owner.actor.credential,
          issued.challengeToken,
          issued.mailPlan.token,
          issued.recoveryToken,
        ])
          expect(encodedPending).not.toContain(secret);

        const prepared = await prepareFirstPasswordChallenge(environment.database, runtime(), {
          ...issued,
          confirmationToken: issued.mailPlan.token,
          password,
          confirmPassword: password,
        });
        expect(await selectedPassword(owner.userId)).toBeNull();
        const beforePublication = await stored(issued.challengeToken);
        expect(beforePublication).toMatchObject({ phase: 'prepared', consumedAt: null });
        expect(await compare(password, beforePublication.pendingPasswordHash ?? '')).toBe(true);
        // No token is minted: the presented one continues.
        expect(beforePublication.proposedCredentialHash).toBe(beforePublication.actorCredentialHash);
        expect(prepared).not.toHaveProperty('proposedCanonicalToken');
        expect(prepared).not.toHaveProperty('credentialProof');
        expect(prepared.user.emailVerified).toEqual(beforePublication.preparedAt);
        const [beforeUser] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
        expect(beforeUser.emailVerified).toBeNull();
        const affected = await partner(owner.userId);
        const unrelatedId = randomUUID();
        await environment.database.insert(users).values({ id: unrelatedId, email: `${unrelatedId}@example.test` });
        const unrelated = await partner(unrelatedId);
        const nativeId = randomUUID();
        await environment.database.insert(mobileRefreshTokens).values({
          id: nativeId,
          userId: owner.userId,
          tokenHash: randomBytes(32).toString('hex'),
          expiresAt: new Date(Date.now() + 3_600_000),
        });
        const other = await environment.secondSession(owner);
        const command = { ...issued, ...prepared };
        const providerReceiptsBefore = await environment.database.select().from(authProviderReauthenticationReceipts);
        expect(await finalizeFirstPasswordChallenge(environment.database, runtime(), command)).toEqual({
          outcome: 'committed',
          generation: 1,
        });
        const chosenPassword = await selectedPassword(owner.userId);
        expect(chosenPassword?.generation).toBe(1);
        expect(await compare(password, chosenPassword?.passwordHash ?? '')).toBe(true);
        const legacy = await environment.database
          .select()
          .from(userCredentials)
          .where(eq(userCredentials.userId, owner.userId));
        // Canonical authority always maintains its mandatory rollback copy;
        // the flag controls the opposite, legacy-to-canonical direction.
        expect(legacy).toHaveLength(1);
        expect(await compare(password, legacy[0].passwordHash)).toBe(true);
        const completed = await stored(issued.challengeToken);
        expect(completed).toMatchObject({ phase: 'committed', pendingPasswordHash: null });
        expect(completed.candidateCredentialHash).toBe(completed.actorCredentialHash);
        expect(completed.consumedAt).toBeInstanceOf(Date);
        const [afterUser] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
        expect(afterUser.emailVerified).toEqual(prepared.user.emailVerified);
        // The same token continues: same id, sign-in time and expiry, new generation.
        const continuation = await admit(owner.credential);
        if (continuation.status !== 'admitted') throw new Error('The requesting session did not survive');
        expect(continuation.session).toEqual({ ...original.session, generation: 1 });
        const [afterRow] = await environment.database.select().from(authSession).where(eq(authSession.id, owner.sid));
        expect(afterRow).toEqual({ ...originalRow, revocationGeneration: 1, updatedAt: afterRow.updatedAt });
        // Every other session of the account ends.
        expect(await admit(other.credential)).toEqual({ status: 'denied' });
        expect(await acknowledgeFirstPasswordResult(environment.database, runtime(), command)).toEqual({
          outcome: 'recovered',
          generation: 1,
        });
        await expect(
          acknowledgeFirstPasswordResult(environment.database, runtime(), {
            ...command,
            recoveryToken: randomBytes(32).toString('base64url'),
          }),
        ).rejects.toMatchObject({ outcome: 'denied', code: 'invalid_proof' });
        const [native] = await environment.database
          .select()
          .from(mobileRefreshTokens)
          .where(eq(mobileRefreshTokens.id, nativeId));
        expect(native.revokedAt).toBeInstanceOf(Date);
        const [affectedConnection] = await environment.database
          .select()
          .from(oauthConnections)
          .where(eq(oauthConnections.id, affected.connectionId));
        expect(affectedConnection).toMatchObject({ generation: 1, revocationReason: 'account_security_revocation' });
        expect(affectedConnection.revokedAt).toBeInstanceOf(Date);
        expect(
          await environment.database.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.id, affected.tokenId)),
        ).toHaveLength(0);
        const [unrelatedConnection] = await environment.database
          .select()
          .from(oauthConnections)
          .where(eq(oauthConnections.id, unrelated.connectionId));
        expect(unrelatedConnection).toMatchObject({ generation: 0, revokedAt: null });
        expect(
          await environment.database
            .select()
            .from(oauthRefreshToken)
            .where(eq(oauthRefreshToken.id, unrelated.tokenId)),
        ).toHaveLength(1);

        // Email confirmation itself never manufactures provider freshness.
        expect(await environment.database.select().from(authProviderReauthenticationReceipts)).toEqual(
          providerReceiptsBefore,
        );
        // The same session goes on to link a provider, proving the new password.
        const nextIntent = await createProviderSecurityIntent(environment.database, environment.runtime, {
          actor: owner.webActor,
          action: 'link',
          provider: 'google',
          methodId: null,
        });
        const providerCommand = { ...nextIntent, actor: owner.webActor };
        await expect(
          reauthenticateProviderWithPassword(environment.database, environment.runtime, {
            ...providerCommand,
            password: 'a different password',
          }),
        ).rejects.toMatchObject({ outcome: 'reauthentication_required', code: 'invalid_proof' });
        expect(
          await reauthenticateProviderWithPassword(environment.database, environment.runtime, {
            ...providerCommand,
            password,
          }),
        ).toMatchObject({ reauthenticationToken: expect.any(String) });
      });
    }

    it(`${selected}: wrong confirmation and changed current email preserve password absence and the unconsumed challenge`, async () => {
      const owner = await environment.actor(selected, 'canonical-token', { password: false, provider: 'apple' });
      const issued = await setup(owner);
      const before = await stored(issued.challengeToken);
      await expect(
        prepareFirstPasswordChallenge(environment.database, runtime(), {
          ...issued,
          confirmationToken: randomBytes(32).toString('base64url'),
          password,
          confirmPassword: password,
        }),
      ).rejects.toMatchObject({ outcome: 'denied', code: 'invalid_proof' });
      expect(await stored(issued.challengeToken)).toEqual(before);
      await environment.database
        .update(users)
        .set({ email: `${randomUUID()}@example.test` })
        .where(eq(users.id, owner.userId));
      await expect(
        prepareFirstPasswordChallenge(environment.database, runtime(), {
          ...issued,
          confirmationToken: issued.mailPlan.token,
          password,
          confirmPassword: password,
        }),
      ).rejects.toMatchObject({ outcome: 'denied', code: 'not_eligible' });
      expect(await selectedPassword(owner.userId)).toBeNull();
      expect(await stored(issued.challengeToken)).toEqual(before);
    });
    it(`${selected}: first-password confirmation preserves an already-verified timestamp and the source authentication age`, async () => {
      const owner = await environment.actor(selected, 'canonical-token', { password: false, provider: 'apple' });
      const verifiedAt = new Date('2020-01-02T03:04:05.000Z');
      await environment.database.update(users).set({ emailVerified: verifiedAt }).where(eq(users.id, owner.userId));
      const command = await prepare(owner);
      expect(command.user.emailVerified).toEqual(verifiedAt);
      await finalizeFirstPasswordChallenge(environment.database, runtime(), command);
      const [user] = await environment.database.select().from(users).where(eq(users.id, owner.userId));
      expect(user.emailVerified).toEqual(verifiedAt);
      // Setting the password never moves the session's sign-in time.
      expect(await admit(owner.credential)).toMatchObject({
        status: 'admitted',
        session: { authenticatedAt: owner.authenticatedAt, generation: 1 },
      });
    });

    it(`${selected}: account deletion cascades prepared bcrypt material and the old challenge cannot replay`, async () => {
      const owner = await environment.actor(selected, 'canonical-token', { password: false, provider: 'apple' });
      const command = await prepare(owner);
      expect((await stored(command.challengeToken)).pendingPasswordHash).toMatch(/^[$]2/);
      await environment.database.delete(users).where(eq(users.id, owner.userId));
      expect(await stored(command.challengeToken)).toBeUndefined();
      await expect(finalizeFirstPasswordChallenge(environment.database, runtime(), command)).rejects.toMatchObject({
        outcome: 'unauthenticated',
        code: 'invalid_proof',
      });
      expect(
        await environment.database
          .select()
          .from(authFirstPasswordChallenges)
          .where(eq(authFirstPasswordChallenges.userId, owner.userId)),
      ).toHaveLength(0);
      expect(
        await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, owner.userId)),
      ).toHaveLength(0);
    });

    it(`${selected}: superseding a prepared challenge scrubs its hash and changed owned email cannot reuse the old confirmation`, async () => {
      const owner = await environment.actor(selected, 'canonical-token', { password: false, provider: 'apple' });
      const first = await prepare(owner);
      const next = await requestFirstPasswordChallenge(environment.database, runtime(), { actor: owner.webActor });
      expect(await stored(first.challengeToken)).toMatchObject({
        phase: 'terminal',
        pendingPasswordHash: null,
        preparationTokenHash: null,
      });
      await expect(finalizeFirstPasswordChallenge(environment.database, runtime(), first)).rejects.toBeInstanceOf(
        Error,
      );
      expect(await selectedPassword(owner.userId)).toBeNull();
      const newEmail = `${randomUUID()}@example.test`;
      await environment.database.update(users).set({ email: newEmail }).where(eq(users.id, owner.userId));
      await environment.database.insert(authEmailReservations).values({
        normalizedEmail: newEmail,
        basisProjectionId: environment.qualification.expectedProjectionId,
        state: 'owned',
        ownerUserId: owner.userId,
      });
      await environment.database
        .insert(authEmailReservationMembers)
        .values({ normalizedEmail: newEmail, userId: owner.userId });
      const before = await stored(next.challengeToken);
      await expect(
        prepareFirstPasswordChallenge(environment.database, runtime(), {
          actor: owner.webActor,
          ...next,
          confirmationToken: next.mailPlan.token,
          password,
          confirmPassword: password,
        }),
      ).rejects.toMatchObject({ outcome: 'identity_changed', code: 'email_changed' });
      expect(await stored(next.challengeToken)).toEqual(before);
      expect(await selectedPassword(owner.userId)).toBeNull();
    });

    it(`${selected}: wrong prepared token, another session and a wrong actor cannot set a password or consume the challenge`, async () => {
      const owner = await environment.actor(selected, 'canonical-token', { password: false, provider: 'apple' });
      const command = await prepare(owner);
      const other = await environment.secondSession(owner);
      const before = await snapshot(owner, command.challengeToken);
      await expect(
        finalizeFirstPasswordChallenge(environment.database, runtime(), {
          ...command,
          preparationToken: randomBytes(32).toString('base64url'),
        }),
      ).rejects.toMatchObject({ outcome: 'denied', code: 'invalid_proof' });
      await expect(
        finalizeFirstPasswordChallenge(environment.database, runtime(), { ...command, actor: other.webActor }),
      ).rejects.toMatchObject({ outcome: 'identity_changed', code: 'invalid_proof' });
      await expect(
        finalizeFirstPasswordChallenge(environment.database, runtime(), {
          ...command,
          actor: { ...command.actor, expectedUserId: randomUUID() },
        }),
      ).rejects.toMatchObject({ outcome: 'identity_changed', code: 'invalid_proof' });
      await expect(
        finalizeFirstPasswordChallenge(environment.database, runtime(), {
          ...command,
          actor: {
            ...command.actor,
            presented: { kind: 'canonical-token', token: randomBytes(32).toString('base64url') },
          },
        }),
      ).rejects.toMatchObject({ outcome: 'unauthenticated', code: 'invalid_proof' });
      expect(await snapshot(owner, command.challengeToken)).toEqual(before);
    });

    it(`${selected}: expiry during an observed advisory-locked final challenge write rolls back every credential and revocation write`, async () => {
      const owner = await environment.actor(selected, 'canonical-token', { password: false, provider: 'apple' });
      const command = await prepare(owner);
      await partner(owner.userId);
      await environment.database.insert(mobileRefreshTokens).values({
        userId: owner.userId,
        tokenHash: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await environment.database.execute(
        sql`UPDATE auth_first_password_challenges SET expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE challenge_hash=${firstPasswordTokenHash('challenge', command.challengeToken)}`,
      );
      const before = await snapshot(owner, command.challengeToken);
      const expiresAt = before.challenge.expiresAt.getTime();
      const address = new URL(
        process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
      );
      address.pathname = `/${environment.client.options.database}`;
      const observer = postgres(address.toString(), { max: 2, onnotice: () => {} });
      const advisoryKey = 69750314;
      let held = () => {};
      let release = () => {};
      const acquired = new Promise<void>((resolve) => {
        held = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = observer.begin(async (transaction) => {
        await transaction`SELECT pg_advisory_xact_lock(${advisoryKey})`;
        held();
        await released;
      });
      await acquired;
      await environment.database.execute(
        sql`CREATE FUNCTION hold_first_password_final_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.phase='committed' THEN PERFORM pg_advisory_xact_lock(69750314); END IF; RETURN NEW; END $$`,
      );
      await environment.database.execute(
        sql`CREATE TRIGGER hold_first_password_final_write BEFORE UPDATE ON auth_first_password_challenges FOR EACH ROW EXECUTE FUNCTION hold_first_password_final_write()`,
      );
      const pending = finalizeFirstPasswordChallenge(environment.database, runtime(), command).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        let observedWait = false;
        const until = Date.now() + 2000;
        while (!observedWait && Date.now() < until) {
          const [state] = await observer<
            { waiting: boolean }[]
          >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%update%auth_first_password_challenges%') AS waiting`;
          observedWait = state.waiting;
          if (!observedWait) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(observedWait).toBe(true);
        while ((await databaseMilliseconds()) <= expiresAt) await new Promise((resolve) => setTimeout(resolve, 10));
        release();
        await holding;
        expect(await pending).toMatchObject({ error: { outcome: 'denied', code: 'expired' } });
        expect(await snapshot(owner, command.challengeToken)).toEqual(before);
      } finally {
        release();
        await holding;
        await pending;
        await environment.database.execute(
          sql`DROP TRIGGER hold_first_password_final_write ON auth_first_password_challenges`,
        );
        await environment.database.execute(sql`DROP FUNCTION hold_first_password_final_write()`);
        await observer.end({ timeout: 5 });
      }
    });

    it(`${selected}: the ACK is bounded by confirmation expiry and never survives canonical primary removal`, async () => {
      const owner = await environment.actor(selected, 'canonical-token', { password: false, provider: 'apple' });
      const command = await prepare(owner);
      await environment.database.execute(
        sql`UPDATE auth_first_password_challenges SET expires_at=clock_timestamp()+interval '1500 milliseconds' WHERE challenge_hash=${firstPasswordTokenHash('challenge', command.challengeToken)}`,
      );
      await finalizeFirstPasswordChallenge(environment.database, runtime(), command);
      const committed = await stored(command.challengeToken);
      expect(committed.recoveryExpiresAt).toEqual(committed.expiresAt);
      expect(await acknowledgeFirstPasswordResult(environment.database, runtime(), command)).toMatchObject({
        outcome: 'recovered',
      });
      while ((await databaseMilliseconds()) <= committed.expiresAt.getTime())
        await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(acknowledgeFirstPasswordResult(environment.database, runtime(), command)).rejects.toMatchObject({
        outcome: 'denied',
        code: 'expired',
      });
      const later = await environment.actor(selected, 'canonical-token', { password: false, provider: 'apple' });
      const laterCommand = await prepare(later);
      await finalizeFirstPasswordChallenge(environment.database, runtime(), laterCommand);
      await environment.database.delete(authSession).where(eq(authSession.id, later.sid));
      // The session is gone, so it is not admitted at all.
      await expect(acknowledgeFirstPasswordResult(environment.database, runtime(), laterCommand)).rejects.toMatchObject(
        { outcome: 'unauthenticated', code: 'invalid_proof' },
      );
    });
  }
});
