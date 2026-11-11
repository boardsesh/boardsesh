import { revokeAdministrativeCredentials } from '../admin-revocation';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hkdf } from '@panva/hkdf';
import { EncryptJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  authEmailProjection,
  authSessionDenials,
  authSubjectCutoffs,
  authSecurityMutationEvents,
  users,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { signOutLegacyWebSession } from '../web-signout';
import { runRevokeSessions } from '../../../scripts/auth-revoke-sessions';

const secret = 'isolated-web-signout-command-secret';
async function cookie(userId: string, sessionId: string) {
  const key = await hkdf('sha256', new TextEncoder().encode(secret), '', 'NextAuth.js Generated Encryption Key', 32);
  return new EncryptJWT({ authSessionId: sessionId })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .encrypt(key);
}
describe('private web signout and administrative revoke commands', () => {
  let environment: Awaited<ReturnType<typeof createEnvironment>>;
  beforeAll(async () => {
    environment = await createEnvironment();
  });
  afterAll(async () => environment?.close());
  async function fixture() {
    const userId = randomUUID();
    await environment.database.insert(users).values({ id: userId, email: `command-${userId}@example.com` });
    return userId;
  }
  it('persists a SID denial without prior lineage, retries idempotently and leaves a newer login alone', async () => {
    const userId = await fixture();
    const oldLogin = randomUUID();
    const newLogin = randomUUID();
    const oldCredential = await cookie(userId, oldLogin);
    const newerCredential = await cookie(userId, newLogin);
    expect(await signOutLegacyWebSession(environment.database, oldCredential, secret)).toEqual({
      status: 'signed-out',
    });
    expect(await signOutLegacyWebSession(environment.database, oldCredential, secret)).toEqual({
      status: 'signed-out',
    });
    expect(
      await environment.database.select().from(authSessionDenials).where(eq(authSessionDenials.userId, userId)),
    ).toMatchObject([{ sessionId: oldLogin }]);
    expect(
      await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)),
    ).toHaveLength(0);
    expect(await signOutLegacyWebSession(environment.database, newerCredential, secret)).toEqual({
      status: 'signed-out',
    });
    expect(await signOutLegacyWebSession(environment.database, oldCredential, 'wrong-key')).toEqual({
      status: 'denied',
    });
  });
  it('admin plan stays read-only, apply stays gated, and the qualified core rejects stale generations', async () => {
    const userId = await fixture();
    const projectionId = randomUUID();
    await environment.database.insert(authEmailProjection).values({
      projectionId,
      isCurrent: true,
      normalizerVersion: 'js-trim-lower-v1',
      writerEpoch: 1,
      phase: 'enforced',
      preparedAt: new Date(),
    });
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'boardsesh-revoke-fixture-'));
    chmodSync(directory, 0o700);
    const subjectFile = join(directory, 'subject');
    const keyFile = join(directory, 'key');
    writeFileSync(subjectFile, userId, { mode: 0o600 });
    writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    const databaseUrl = new URL(
      process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
    );
    databaseUrl.pathname = `/${environment.client.options.database}`;
    const operatorEnvironment = { AUTH_OPERATOR_DATABASE_URL: databaseUrl.toString() };
    const flags = ['--confirm-host', databaseUrl.hostname, '--subject-file', subjectFile, '--key-file', keyFile];
    try {
      const plan = await runRevokeSessions(flags, operatorEnvironment);
      expect(plan.status).toBe('planned');
      expect(JSON.stringify(plan)).not.toContain(userId);
      expect(
        await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)),
      ).toHaveLength(0);
      await expect(
        runRevokeSessions(['apply', ...flags, '--plan-sha256', 'wrong'], operatorEnvironment),
      ).rejects.toThrow('PLAN_DIGEST_MISMATCH');
      await expect(
        runRevokeSessions(['apply', ...flags, '--plan-sha256', plan.planDigest], operatorEnvironment),
      ).rejects.toThrow('NATIVE_REVOCATION_ACTIVATION_BLOCKED');
      expect(
        await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId)),
      ).toHaveLength(0);
      await revokeAdministrativeCredentials(
        environment.database,
        { expectedProjectionId: projectionId, expectedNormalizerVersion: 'js-trim-lower-v1', expectedWriterEpoch: 1 },
        userId,
        0,
      );
      const [cutoff] = await environment.database
        .select()
        .from(authSubjectCutoffs)
        .where(eq(authSubjectCutoffs.userId, userId));
      expect(cutoff.generation).toBe(1);
      expect(
        (
          await environment.database
            .select()
            .from(authSecurityMutationEvents)
            .where(eq(authSecurityMutationEvents.userId, userId))
        )[0].kind,
      ).toBe('admin-revocation');
      await expect(
        runRevokeSessions(['apply', ...flags, '--plan-sha256', plan.planDigest], operatorEnvironment),
      ).rejects.toThrow('PLAN_DIGEST_MISMATCH');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
