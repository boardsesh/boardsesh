import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  authEmailReservationMembers,
  authEmailReservations,
  authFirstPasswordChallenges,
  mobileRefreshTokens,
  users,
} from '@boardsesh/db/schema/auth';
import { createProviderSecurityEnvironment } from './provider-security-fixture';
import { captureFirstPasswordRuntime, FIRST_PASSWORD_CHALLENGE_LIFETIME_MS } from '../first-password-policy';
import { withFirstPasswordAuthority } from '../first-password-context';
import { readFirstPasswordChallenge, requestFirstPasswordChallenge } from '../first-password-challenges';
import { finalizeFirstPasswordChallenge, prepareFirstPasswordChallenge } from '../first-password-finalizer';
import { bindIdentityAuthority } from '../identity-authority';
import { createProviderSecurityIntent, readProviderSecurityMethods } from '../provider-security-intents';
import { reauthenticateProviderWithPassword } from '../provider-security-reauthentication';
import { readFirstPartySession } from '../session-reader';
import { readLockedWebSubjectState } from '../../current-store/web-credential-state';
import { normalizeAccountEmail } from '../../normalize-email';
import { RateLimitError } from '../../../utils/rate-limiter';

// Decision of 2026-11-18 on #7596: first password is open to any account with
// no password and a Google or Apple identity, and a durable cap limits the mail.

let environment: Awaited<ReturnType<typeof createProviderSecurityEnvironment>>;
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
const password = 'a first password for a Google climber';
const runtime = () =>
  captureFirstPasswordRuntime({
    qualification: environment.runtime.qualification,
    legacySecret: environment.runtime.legacySecret,
    emailBindingKey: 'owned-first-password-private-rpc-key-7596-any',
  });

/** A Google-only account (no password) that owns its email reservation. */
async function googleOnly() {
  const subject = randomUUID();
  const owner = await environment.actor('better-auth', 'canonical-token', {
    password: false,
    provider: 'google',
    subject,
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
  return { ...owner, subject };
}

async function admit(credential: Owner['credential']) {
  return environment.database.transaction((transaction) =>
    readFirstPartySession(transaction, credential, new Date(), (userId) =>
      readLockedWebSubjectState(transaction, userId),
    ),
  );
}

const challengeRows = (userId: string) =>
  environment.database.select().from(authFirstPasswordChallenges).where(eq(authFirstPasswordChallenges.userId, userId));

describe('first password for any account without one (decision of 2026-11-18)', () => {
  beforeAll(async () => {
    environment = await createProviderSecurityEnvironment();
    await environment.client.unsafe(
      readFileSync(new URL('../../../../../db/drizzle/0314_first_password_challenges.sql', import.meta.url), 'utf8'),
    );
  });
  afterAll(async () => environment?.close());

  it('a Google-only account sets a password: same session at generation + 1, the rest ends, Google stays', async () => {
    const owner = await googleOnly();
    const other = await environment.secondSession(owner);
    const nativeId = randomUUID();
    await environment.database.insert(mobileRefreshTokens).values({
      id: nativeId,
      userId: owner.userId,
      tokenHash: randomBytes(32).toString('hex'),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const before = await admit(owner.credential);
    if (before.status !== 'admitted') throw new Error('Owner session not live');

    const issued = await requestFirstPasswordChallenge(environment.database, runtime(), { actor: owner.webActor });
    const command = { actor: owner.webActor, challengeToken: issued.challengeToken };
    const prepared = await prepareFirstPasswordChallenge(environment.database, runtime(), {
      ...command,
      confirmationToken: issued.mailPlan.token,
      password,
      confirmPassword: password,
    });
    expect(
      await finalizeFirstPasswordChallenge(environment.database, runtime(), {
        ...command,
        preparationToken: prepared.preparationToken,
      }),
    ).toEqual({ outcome: 'committed', generation: 1 });

    const after = await admit(owner.credential);
    if (after.status !== 'admitted') throw new Error('The requesting session did not survive');
    expect(after.session).toEqual({ ...before.session, generation: 1 });
    expect(await admit(other.credential)).toEqual({ status: 'denied' });
    const [native] = await environment.database
      .select()
      .from(mobileRefreshTokens)
      .where(eq(mobileRefreshTokens.id, nativeId));
    expect(native.revokedAt).toBeInstanceOf(Date);
    const google = await withFirstPasswordAuthority(environment.database, runtime(), (transaction, authority) =>
      bindIdentityAuthority(transaction, authority).findProvider('google', owner.subject),
    );
    expect(google).toMatchObject({ userId: owner.userId });

    // The password now counts: methods shows it, and it proves a reauthentication.
    const methods = await readProviderSecurityMethods(environment.database, environment.runtime, owner.webActor);
    expect(methods.passwordUsable).toBe(true);
    expect(methods.providers.find((method) => method.provider === 'google')?.canUnlink).toBe(true);
    const intent = await createProviderSecurityIntent(environment.database, environment.runtime, {
      actor: owner.webActor,
      action: 'link',
      provider: 'apple',
      methodId: null,
    });
    const providerCommand = { ...intent, actor: owner.webActor };
    await expect(
      reauthenticateProviderWithPassword(environment.database, environment.runtime, {
        ...providerCommand,
        password: 'not the password',
      }),
    ).rejects.toMatchObject({ outcome: 'reauthentication_required' });
    expect(
      await reauthenticateProviderWithPassword(environment.database, environment.runtime, {
        ...providerCommand,
        password,
      }),
    ).toMatchObject({ reauthenticationToken: expect.any(String) });
  });

  it("a Google-only account's link cannot be read or confirmed by another session or account", async () => {
    const owner = await googleOnly();
    const sameAccount = await environment.secondSession(owner);
    const otherAccount = await googleOnly();
    const issued = await requestFirstPasswordChallenge(environment.database, runtime(), { actor: owner.webActor });
    const rowsBefore = await challengeRows(owner.userId);
    for (const actor of [sameAccount.webActor, otherAccount.webActor]) {
      const stolen = { actor, challengeToken: issued.challengeToken };
      await expect(readFirstPasswordChallenge(environment.database, runtime(), stolen)).rejects.toMatchObject({
        outcome: 'identity_changed',
      });
      await expect(
        prepareFirstPasswordChallenge(environment.database, runtime(), {
          ...stolen,
          confirmationToken: issued.mailPlan.token,
          password,
          confirmPassword: password,
        }),
      ).rejects.toMatchObject({ outcome: 'identity_changed' });
    }
    expect(await challengeRows(owner.userId)).toEqual(rowsBefore);
    const passwords = await withFirstPasswordAuthority(environment.database, runtime(), (transaction, authority) =>
      Promise.all(
        [owner.userId, otherAccount.userId].map((userId) =>
          bindIdentityAuthority(transaction, authority).readPassword(userId),
        ),
      ),
    );
    expect(passwords).toEqual([null, null]);
  });

  it('caps the mail: a sixth request in an hour, or an eleventh in a day, is refused with no row and no plan', async () => {
    const owner = await googleOnly();
    for (let request = 0; request < 5; request += 1)
      await requestFirstPasswordChallenge(environment.database, runtime(), { actor: owner.webActor });
    const hourRows = await challengeRows(owner.userId);
    expect(hourRows).toHaveLength(5);
    await expect(
      requestFirstPasswordChallenge(environment.database, runtime(), { actor: owner.webActor }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(await challengeRows(owner.userId)).toEqual(hourRows);

    // Move those five back two hours: the hour has room again, the day has five.
    const issuedAt = new Date(Date.now() - 2 * 60 * 60_000);
    const agedChallengeTimes = {
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + FIRST_PASSWORD_CHALLENGE_LIFETIME_MS),
    };
    await environment.database
      .update(authFirstPasswordChallenges)
      .set(agedChallengeTimes)
      .where(eq(authFirstPasswordChallenges.userId, owner.userId));
    for (let request = 0; request < 5; request += 1)
      await requestFirstPasswordChallenge(environment.database, runtime(), { actor: owner.webActor });
    await environment.database
      .update(authFirstPasswordChallenges)
      .set(agedChallengeTimes)
      .where(
        and(eq(authFirstPasswordChallenges.userId, owner.userId), eq(authFirstPasswordChallenges.phase, 'terminal')),
      );
    const dayRows = await challengeRows(owner.userId);
    expect(dayRows).toHaveLength(10);
    await expect(
      requestFirstPasswordChallenge(environment.database, runtime(), { actor: owner.webActor }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(await challengeRows(owner.userId)).toEqual(dayRows);
  });
});
