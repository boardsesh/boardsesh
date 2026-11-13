import { revokeAdministrativeCredentials } from '../admin-revocation';
import { hkdf } from '@panva/hkdf';
import { EncryptJWT } from 'jose';
import { signOutLegacyWebSession } from '../web-signout';
import { readFirstPartySession } from '../session-reader';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, chmodSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { beforeAll, afterAll, expect, it } from 'vite-plus/test';
import {
  authEmailProjection,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  authSessionDenials,
  mobileRefreshTokens,
  oauthClient,
  oauthConnections,
  oauthGrants,
  oauthRefreshToken,
  users,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { revokeNativeCredentials } from '../native-revocation';
import { runRevokeSessions } from '../../../scripts/auth-revoke-sessions';
let first: Awaited<ReturnType<typeof createEnvironment>>;
let second: Awaited<ReturnType<typeof createEnvironment>>;
beforeAll(async () => {
  first = await createEnvironment();
  second = await createEnvironment();
});
afterAll(async () => {
  await first?.close();
  await second?.close();
});
it('an expired refresh secret cannot sign out a newer live native login', async () => {
  const userId = randomUUID();
  const expired = randomUUID();
  const current = randomUUID();
  await first.database.insert(users).values({ id: userId, email: `synthetic-expired-${userId}@example.test` });
  await first.database.insert(mobileRefreshTokens).values([
    { userId, tokenHash: expired, expiresAt: new Date(Date.now() - 1000) },
    {
      userId,
      tokenHash: current,
      expiresAt: new Date(Date.now() + 86400000),
      subjectGeneration: 0,
      nativeGeneration: 0,
    },
  ]);
  expect(await revokeNativeCredentials(first.database, expired, 'generation')).toBe(false);
  expect(
    await first.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)),
  ).toHaveLength(0);
  expect(
    await first.database.select().from(authSecurityMutationEvents).where(eq(authSecurityMutationEvents.userId, userId)),
  ).toHaveLength(0);
  const [live] = await first.database
    .select()
    .from(mobileRefreshTokens)
    .where(eq(mobileRefreshTokens.tokenHash, current));
  expect(live.revokedAt).toBeNull();
});
it('binds an approved administrative revoke plan to its exact database target', async () => {
  const userId = randomUUID();
  const projectionId = randomUUID();
  for (const environment of [first, second]) {
    await environment.database.insert(users).values({ id: userId, email: `synthetic-plan-${userId}@example.test` });
    await environment.database.insert(authEmailProjection).values({
      projectionId,
      isCurrent: true,
      normalizerVersion: 'js-trim-lower-v1',
      writerEpoch: 1,
      phase: 'enforced',
      preparedAt: new Date(),
    });
  }
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'native-admin-review-')));
  chmodSync(folder, 0o700);
  const subjectFile = join(folder, 'subject');
  const keyFile = join(folder, 'key');
  writeFileSync(subjectFile, userId, { mode: 0o600 });
  writeFileSync(keyFile, 'ab'.repeat(32), { mode: 0o600 });
  const target = (environment: typeof first) => {
    const url = new URL(
      process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
    );
    url.pathname = `/${environment.client.options.database}`;
    return url;
  };
  const firstUrl = target(first);
  const secondUrl = target(second);
  const flags = ['--confirm-host', firstUrl.hostname, '--subject-file', subjectFile, '--key-file', keyFile];
  try {
    const plan = await runRevokeSessions(['plan', ...flags], { AUTH_OPERATOR_DATABASE_URL: firstUrl.toString() });
    await expect(
      runRevokeSessions(['apply', ...flags, '--plan-sha256', plan.planDigest], {
        AUTH_OPERATOR_DATABASE_URL: secondUrl.toString(),
      }),
    ).rejects.toThrow('PLAN_DIGEST_MISMATCH');
    expect(
      await second.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)),
    ).toHaveLength(0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

it('administrative all-domain revocation invalidates actual partner connections, grants and refresh tokens', async () => {
  const userId = randomUUID();
  const clientId = randomUUID();
  const connectionId = randomUUID();
  await first.database.insert(users).values({ id: userId, email: `synthetic-partner-${userId}@example.test` });
  await first.database
    .insert(oauthClient)
    .values({ id: clientId, clientId, redirectUris: ['https://synthetic.example.test/callback'] });
  await first.database
    .insert(oauthConnections)
    .values({ id: connectionId, userId, clientId, generation: 0, scopes: ['logbook:read'] });
  await first.database.insert(oauthGrants).values({ authorizationCodeId: randomUUID(), connectionId, generation: 0 });
  await first.database.insert(oauthRefreshToken).values({
    id: randomUUID(),
    token: randomUUID(),
    userId,
    clientId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
    scopes: ['logbook:read'],
  });
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'native-partner-review-')));
  chmodSync(folder, 0o700);
  const subjectFile = join(folder, 'subject');
  const keyFile = join(folder, 'key');
  writeFileSync(subjectFile, userId, { mode: 0o600 });
  writeFileSync(keyFile, 'ab'.repeat(32), { mode: 0o600 });
  const url = new URL(
    process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
  );
  url.pathname = `/${first.client.options.database}`;
  const flags = ['--confirm-host', url.hostname, '--subject-file', subjectFile, '--key-file', keyFile];
  const settings = { AUTH_OPERATOR_DATABASE_URL: url.toString() };
  try {
    const plan = await runRevokeSessions(['plan', ...flags], settings);
    await expect(runRevokeSessions(['apply', ...flags, '--plan-sha256', plan.planDigest], settings)).rejects.toThrow(
      'NATIVE_REVOCATION_ACTIVATION_BLOCKED',
    );
    const [manifest] = await first.database
      .select()
      .from(authEmailProjection)
      .where(eq(authEmailProjection.isCurrent, true));
    await revokeAdministrativeCredentials(
      first.database,
      {
        expectedProjectionId: manifest.projectionId,
        expectedNormalizerVersion: manifest.normalizerVersion,
        expectedWriterEpoch: manifest.writerEpoch,
      },
      userId,
      0,
    );
    const [connection] = await first.database
      .select()
      .from(oauthConnections)
      .where(eq(oauthConnections.id, connectionId));
    expect(connection.revokedAt).not.toBeNull();
    expect(connection.generation).toBe(1);
    expect(
      await first.database.select().from(oauthGrants).where(eq(oauthGrants.connectionId, connectionId)),
    ).toHaveLength(0);
    expect(
      await first.database.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.userId, userId)),
    ).toHaveLength(0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
it('rolls back cutoff and event on a semantic secret-disappearance failure after preceding writes', async () => {
  const userId = randomUUID();
  const tokenHash = randomUUID();
  await first.database.insert(users).values({ id: userId, email: `synthetic-atomic-${userId}@example.test` });
  await first.database
    .insert(mobileRefreshTokens)
    .values({ userId, tokenHash, expiresAt: new Date(Date.now() + 86400000) });
  await first.client.unsafe(
    "CREATE FUNCTION review_pause_native_event() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END'; CREATE TRIGGER review_pause_native_event BEFORE INSERT ON auth_security_mutation_events FOR EACH ROW EXECUTE FUNCTION review_pause_native_event()",
  );
  const revoking = revokeNativeCredentials(first.database, tokenHash, 'generation');
  try {
    let paused = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const [probe] =
        await first.client`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event='PgSleep' AND query LIKE '%auth_security_mutation_events%'`;
      if (probe.count > 0) {
        paused = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(paused).toBe(true);
    // Simulate a nonparticipating cleanup deleting this capability without a parent-user lock.
    await first.database.delete(mobileRefreshTokens).where(eq(mobileRefreshTokens.tokenHash, tokenHash));
    await expect(revoking).rejects.toThrow('Authentication is required');
    expect(
      await first.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)),
    ).toHaveLength(0);
    expect(
      await first.database
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.userId, userId)),
    ).toHaveLength(0);
  } finally {
    await Promise.allSettled([revoking]);
    await first.client.unsafe(
      'DROP TRIGGER review_pause_native_event ON auth_security_mutation_events; DROP FUNCTION review_pause_native_event()',
    );
  }
});

it('requires selected authority before no-SID signout and leaves the other valid rotation admitted', async () => {
  const userId = randomUUID();
  await first.database.insert(users).values({ id: userId, email: `synthetic-nosid-${userId}@example.test` });
  const secret = 'synthetic-nosid-review-secret';
  const key = await hkdf('sha256', new TextEncoder().encode(secret), '', 'NextAuth.js Generated Encryption Key', 32);
  const mint = () =>
    new EncryptJWT({})
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('1h')
      .encrypt(key);
  const credential = await mint();
  const rotation = await mint();
  const signedOut = await signOutLegacyWebSession(first.database, credential, secret);
  const readSubject = async () => {
    const [cutoff] = await first.database
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, userId));
    const denials = await first.database.select().from(authSessionDenials).where(eq(authSessionDenials.userId, userId));
    return {
      generation: cutoff?.generation ?? 0,
      nativeGeneration: cutoff?.nativeGeneration ?? 0,
      deniedSessionKeys: new Set(denials.map((row) => row.sessionId)),
    };
  };
  const other = await readFirstPartySession(
    first.database,
    { kind: 'legacy-jwe', credential: rotation, secret },
    new Date(),
    readSubject,
  );
  expect(signedOut.status).toBe('unavailable');
  expect(other.status).toBe('admitted');
});
it('a live refresh secret from an older native generation cannot end a newer login', async () => {
  const userId = randomUUID();
  const oldSecret = randomUUID();
  const currentSecret = randomUUID();
  await first.database.insert(users).values({ id: userId, email: `synthetic-generation-${userId}@example.test` });
  await first.database
    .insert(authSubjectCutoffs)
    .values({ userId, generation: 0, nativeGeneration: 1, revokedThrough: new Date(0), lastOperationId: randomUUID() });
  await first.database.insert(mobileRefreshTokens).values([
    {
      userId,
      tokenHash: oldSecret,
      subjectGeneration: 0,
      nativeGeneration: 0,
      expiresAt: new Date(Date.now() + 86400000),
    },
    {
      userId,
      tokenHash: currentSecret,
      subjectGeneration: 0,
      nativeGeneration: 1,
      expiresAt: new Date(Date.now() + 86400000),
    },
  ]);
  expect(await revokeNativeCredentials(first.database, oldSecret, 'generation')).toBe(false);
  const [cutoff] = await first.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId));
  expect(cutoff.nativeGeneration).toBe(1);
  const [current] = await first.database
    .select()
    .from(mobileRefreshTokens)
    .where(eq(mobileRefreshTokens.tokenHash, currentSecret));
  expect(current.revokedAt).toBeNull();
});
