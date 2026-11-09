import { createHash, randomUUID } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import { and, eq, sql } from 'drizzle-orm';
import { decodeJwt, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../environment';
import { PROTOTYPE_CONFIGURATION } from '../configuration';
import { planPrototypeIdentityImport } from '../identity-fixtures';
import { createPrototypeNativeFacade, PrototypeNativeCredentialError } from '../identity-native-facade';
import { revokePrototypeUser } from '../legacy-bridge';
import { assertLegacyNativeTokenPair } from './identity-native-contract';

const nativeKey = new TextEncoder().encode('boardsesh-synthetic-native-contract-key-6975');
const password = ' café-山-🧗-password ';

describe('native/Garmin token-pair facade over canonical Better Auth sessions', () => {
  let environment: Awaited<ReturnType<typeof createPrototypeEnvironment>>;
  let passwordHash: string;
  let primary: ReturnType<typeof createPrototypeNativeFacade>;
  let secondary: ReturnType<typeof createPrototypeNativeFacade>;

  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    passwordHash = await hash(password, 4);
    primary = createPrototypeNativeFacade(environment.database, nativeKey);
    secondary = createPrototypeNativeFacade(environment.database, nativeKey);
  });
  afterAll(async () => environment?.close());

  async function fixture() {
    const id = randomUUID();
    const email = `native-${id}@example.com`;
    const plan = planPrototypeIdentityImport([
      {
        id,
        email,
        name: 'Native contract fixture',
        image: null,
        emailVerifiedAt: null,
        createdAt: new Date('2023-01-01T00:00:00Z'),
        updatedAt: new Date(),
        passwordHash,
        providers: [],
      },
    ]);
    await environment.database.transaction(async (transaction) => {
      await transaction.insert(environment.schema.user).values(plan.users);
      await transaction.insert(environment.schema.account).values(plan.accounts);
    });
    return { id, email };
  }

  it('returns the released native/watch shape after central bcrypt verification and email normalization', async () => {
    const user = await fixture();
    const response = await primary.credentials(` ${user.email.toUpperCase()} `, password);
    const claims = await assertLegacyNativeTokenPair(response, nativeKey, user.id);
    expect(await secondary.validateAccessToken(response.jwt)).toEqual({ userId: user.id, sessionId: claims.sid });
    const [refresh] = await environment.database
      .select()
      .from(environment.schema.prototypeNativeRefresh)
      .where(eq(environment.schema.prototypeNativeRefresh.userId, user.id));
    expect(refresh.tokenHash).toBe(createHash('sha256').update(response.refreshToken).digest('hex'));
    expect(refresh.tokenHash).not.toBe(response.refreshToken);
    expect(refresh.expiresAt.getTime() - refresh.createdAt.getTime()).toBe(90 * 24 * 60 * 60 * 1000);
    const [session] = await environment.database
      .select()
      .from(environment.schema.session)
      .where(eq(environment.schema.session.id, refresh.sessionId));
    expect(session.expiresAt).toEqual(refresh.expiresAt);
    expect(claims.auth_time).toBe(Math.floor(session.createdAt.getTime() / 1000));
    const [credential] = await environment.database
      .select()
      .from(environment.schema.account)
      .where(eq(environment.schema.account.userId, user.id));
    expect(credential.password).toBe(passwordHash);
  });

  it('rejects wrong-password and unknown-user attempts without a native credential', async () => {
    const user = await fixture();
    await expect(primary.credentials(user.email, 'wrong-password')).rejects.toBeInstanceOf(
      PrototypeNativeCredentialError,
    );
    await expect(primary.credentials('unknown-native@example.com', 'wrong-password')).rejects.toBeInstanceOf(
      PrototypeNativeCredentialError,
    );
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeNativeRefresh)
        .where(eq(environment.schema.prototypeNativeRefresh.userId, user.id)),
    ).toEqual([]);
  });

  it('rotates an opaque refresh credential once across two instances without changing its owner', async () => {
    const user = await fixture();
    const initial = await primary.credentials(user.email, password);
    const rotated = await secondary.refresh(initial.refreshToken);
    await assertLegacyNativeTokenPair(rotated, nativeKey, user.id);
    expect(rotated.refreshToken).not.toBe(initial.refreshToken);
    await expect(primary.refresh(initial.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    expect((await primary.refresh(rotated.refreshToken)).userId).toBe(user.id);
  });

  it('allows exactly one concurrent refresh of the same credential', async () => {
    const user = await fixture();
    const initial = await primary.credentials(user.email, password);
    const outcomes = await Promise.allSettled([
      primary.refresh(initial.refreshToken),
      secondary.refresh(initial.refreshToken),
    ]);
    const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(accepted).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    if (accepted[0].status !== 'fulfilled') throw new Error('Expected one refresh result');
    await assertLegacyNativeTokenPair(accepted[0].value, nativeKey, user.id);
  });

  it('never replaces original authentication time with the refreshed JWT issuance time', async () => {
    const user = await fixture();
    const initial = await primary.credentials(user.email, password);
    const originalAuthenticatedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await environment.database
      .update(environment.schema.session)
      .set({ createdAt: originalAuthenticatedAt })
      .where(eq(environment.schema.session.userId, user.id));
    const rotated = await secondary.refresh(initial.refreshToken);
    const claims = await assertLegacyNativeTokenPair(rotated, nativeKey, user.id);
    expect(claims.auth_time).toBe(Math.floor(originalAuthenticatedAt.getTime() / 1000));
    expect(claims.iat).toBeGreaterThan(claims.auth_time as number);
    const [session] = await environment.database
      .select()
      .from(environment.schema.session)
      .where(eq(environment.schema.session.userId, user.id));
    expect(session.createdAt).toEqual(originalAuthenticatedAt);
  });

  it('never invents a fresh authentication time for an unknown-age legacy lineage', async () => {
    const user = await fixture();
    const initial = await primary.credentials(user.email, password);
    await environment.database
      .update(environment.schema.session)
      .set({ createdAt: new Date(0), originalAuthenticatedAt: null, legacyLineageId: `legacy-${user.id}` })
      .where(eq(environment.schema.session.userId, user.id));
    const rotated = await secondary.refresh(initial.refreshToken);
    expect((await assertLegacyNativeTokenPair(rotated, nativeKey, user.id)).auth_time).toBeUndefined();
    expect(await secondary.validateAccessToken(rotated.jwt)).not.toBeNull();
  });

  it('rejects expired refresh records without creating a successor', async () => {
    const user = await fixture();
    const initial = await primary.credentials(user.email, password);
    await environment.database
      .update(environment.schema.prototypeNativeRefresh)
      .set({ expiresAt: new Date(0) })
      .where(eq(environment.schema.prototypeNativeRefresh.userId, user.id));
    await expect(secondary.refresh(initial.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeNativeRefresh)
        .where(eq(environment.schema.prototypeNativeRefresh.userId, user.id)),
    ).toHaveLength(1);
  });

  it('rejects canonical account cutoffs on both legacy access and refresh transports', async () => {
    const user = await fixture();
    const initial = await primary.credentials(user.email, password);
    await environment.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975, 1)`);
      await transaction
        .insert(environment.schema.prototypeUserCutoff)
        .values({ userId: user.id, revokedThrough: new Date() });
    });
    expect(await secondary.validateAccessToken(initial.jwt)).toBeNull();
    await expect(secondary.refresh(initial.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
  });

  it('rejects validly signed tokens for another audience or subject', async () => {
    const user = await fixture();
    const initial = await primary.credentials(user.email, password);
    const claims = decodeJwt(initial.jwt);
    for (const changed of [{ aud: 'partner-api' }, { sub: 'another-account' }]) {
      const invalid = await new SignJWT({ ...claims, ...changed })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .sign(nativeKey);
      expect(await secondary.validateAccessToken(invalid)).toBeNull();
    }
    expect(await secondary.validateAccessToken('opaque-partner-token')).toBeNull();
  });

  it('rejects access and refresh after canonical user deletion', async () => {
    const user = await fixture();
    const initial = await primary.credentials(user.email, password);
    await environment.database.delete(environment.schema.user).where(eq(environment.schema.user.id, user.id));
    expect(await secondary.validateAccessToken(initial.jwt)).toBeNull();
    await expect(secondary.refresh(initial.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeNativeRefresh)
        .where(eq(environment.schema.prototypeNativeRefresh.userId, user.id)),
    ).toEqual([]);
  });

  it('keeps a refresh response inside the same canonical session', async () => {
    const user = await fixture();
    const initial = await primary.credentials(user.email, password);
    const rotated = await secondary.refresh(initial.refreshToken);
    expect(decodeJwt(rotated.jwt).sid).toBe(decodeJwt(initial.jwt).sid);
    const refreshRecords = await environment.database
      .select()
      .from(environment.schema.prototypeNativeRefresh)
      .where(and(eq(environment.schema.prototypeNativeRefresh.userId, user.id)));
    expect(refreshRecords).toHaveLength(2);
    expect(new Set(refreshRecords.map((record) => record.sessionId)).size).toBe(1);
  });

  it('accepts an unexpired consumed ancestor for account signout and preserves other accounts/connections', async () => {
    const user = await fixture();
    const unrelated = await fixture();
    const initial = await primary.credentials(user.email, password);
    const rotated = await secondary.refresh(initial.refreshToken);
    const anotherDevice = await primary.credentials(user.email, password);
    const unrelatedDevice = await primary.credentials(unrelated.email, password);
    const connectionId = randomUUID();
    await environment.database
      .insert(environment.schema.prototypeOAuthConnection)
      .values({ id: connectionId, userId: user.id, clientId: 'retained-partner-connection' });

    await secondary.revoke(initial.refreshToken);

    expect(await primary.validateAccessToken(initial.jwt)).toBeNull();
    expect(await primary.validateAccessToken(rotated.jwt)).toBeNull();
    expect(await primary.validateAccessToken(anotherDevice.jwt)).toBeNull();
    await expect(primary.refresh(rotated.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    expect(await primary.validateAccessToken(unrelatedDevice.jwt)).not.toBeNull();
    const [connection] = await environment.database
      .select()
      .from(environment.schema.prototypeOAuthConnection)
      .where(eq(environment.schema.prototypeOAuthConnection.id, connectionId));
    expect(connection.revokedAt).toBeNull();
    expect(connection.generation).toBe(0);
  });

  it('leaves no live refresh-race descendant after account signout completes', async () => {
    const user = await fixture();
    const initial = await primary.credentials(user.email, password);
    const outcomes = await Promise.allSettled([
      primary.refresh(initial.refreshToken),
      secondary.revoke(initial.refreshToken),
    ]);
    expect(outcomes[1].status).toBe('fulfilled');
    if (outcomes[0].status === 'fulfilled') {
      expect(await primary.validateAccessToken(outcomes[0].value.jwt)).toBeNull();
      await expect(primary.refresh(outcomes[0].value.refreshToken)).rejects.toBeInstanceOf(
        PrototypeNativeCredentialError,
      );
    }
    expect(await primary.validateAccessToken(initial.jwt)).toBeNull();
    await expect(primary.refresh(initial.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
  });

  it('cannot sign out a newly authenticated account using an already-removed ancestor', async () => {
    const user = await fixture();
    const initial = await primary.credentials(user.email, password);
    await secondary.revoke(initial.refreshToken);
    const signedInAgain = await primary.credentials(user.email, password);
    await expect(secondary.revoke(initial.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    expect(await primary.validateAccessToken(signedInAgain.jwt)).not.toBeNull();
  });

  it('rejects unknown and expired signout secrets', async () => {
    const user = await fixture();
    const initial = await primary.credentials(user.email, password);
    await environment.database
      .update(environment.schema.prototypeNativeRefresh)
      .set({ expiresAt: new Date(0) })
      .where(eq(environment.schema.prototypeNativeRefresh.userId, user.id));
    await expect(secondary.revoke('unknown-secret')).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    await expect(secondary.revoke(initial.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    expect(await primary.validateAccessToken(initial.jwt)).not.toBeNull();
  });

  it('serializes password verification and issuance before a racing reset cutoff', async () => {
    const user = await fixture();
    let releaseVerification!: () => void;
    let announceVerification!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      announceVerification = resolve;
    });
    const verificationMayContinue = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const delayed = createPrototypeNativeFacade(environment.database, nativeKey, {
      emailAndPassword: {
        ...PROTOTYPE_CONFIGURATION.emailAndPassword,
        password: {
          ...PROTOTYPE_CONFIGURATION.emailAndPassword.password,
          async verify({ hash: storedHash, password: attemptedPassword }) {
            announceVerification();
            await verificationMayContinue;
            return compare(attemptedPassword, storedHash);
          },
        },
      },
    });
    const signingIn = delayed.credentials(user.email, password);
    await verificationStarted;
    const newPassword = 'new-password-after-race';
    const newPasswordHash = await hash(newPassword, 4);
    const resetting = environment.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975, 1)`);
      await transaction
        .update(environment.schema.account)
        .set({ password: newPasswordHash })
        .where(
          and(eq(environment.schema.account.userId, user.id), eq(environment.schema.account.providerId, 'credential')),
        );
      await revokePrototypeUser(transaction, user.id);
    });
    releaseVerification();
    const [signedIn] = await Promise.all([signingIn, resetting]);
    expect(await secondary.validateAccessToken(signedIn.jwt)).toBeNull();
    await expect(secondary.refresh(signedIn.refreshToken)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    await expect(secondary.credentials(user.email, password)).rejects.toBeInstanceOf(PrototypeNativeCredentialError);
    expect((await secondary.credentials(user.email, newPassword)).userId).toBe(user.id);
  });

  it('rolls back canonical session creation if the authority hook fails', async () => {
    const user = await fixture();
    const failing = createPrototypeNativeFacade(environment.database, nativeKey, {
      databaseHooks: {
        session: {
          create: {
            async after() {
              throw new Error('Synthetic session-creation failure');
            },
          },
        },
      },
    });
    await expect(failing.credentials(user.email, password)).rejects.toThrow('Synthetic session-creation failure');
    expect(
      await environment.database
        .select()
        .from(environment.schema.session)
        .where(eq(environment.schema.session.userId, user.id)),
    ).toEqual([]);
    expect(
      await environment.database
        .select()
        .from(environment.schema.prototypeNativeRefresh)
        .where(eq(environment.schema.prototypeNativeRefresh.userId, user.id)),
    ).toEqual([]);
  });
});
