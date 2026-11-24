import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { AUTH_PROTOCOL_VERSION, REGISTRATION_COMMAND_PATHS, registerReplySchema } from '@boardsesh/auth-protocol';
import {
  authEmailVerificationTokens,
  authPasswordChangeEvidence,
  mobileRefreshTokens,
  userCredentials,
  users,
} from '@boardsesh/db/schema/auth';
import { qualifyCredentialWriter } from '@boardsesh/db/credential-writer-acl';
import {
  createCredentialWriterEnvironment,
  grantOwnedCredentialWriterCapabilities,
  ownedCredentialProofUrl,
} from './fixtures/credential-writer-environment';
import {
  closeCredentialDatabase,
  getCredentialDatabase,
  qualifyPasswordChangeEvidenceAtStartup,
} from '../../credential-database';
import { passwordFingerprint } from '../../password-change-evidence';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { handleCurrentStoreRegistration } from '../../../handlers/current-store-registration';
import { handleNativeAuthRegister, __resetNativeAuthStateForTests } from '../../../handlers/native-auth';

vi.mock('../../../db/client', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('UNEXPECTED_CONTENT_DATABASE');
      },
    },
  ),
}));
const secret = 'owned-registration-evidence-command-secret-6975';
const copyName = `epic6975_identity_import_${randomUUID().replaceAll('-', '')}`;
let admin: postgres.Sql;
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let server: Server;
let origin: string;
async function post(payload: unknown, native = false) {
  const response = await fetch(`${origin}${native ? '/auth/native/register' : REGISTRATION_COMMAND_PATHS.register}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(!native ? { authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
function command(email: string, clientAddress?: string) {
  return {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'register',
    requestId: randomUUID(),
    issuedAt: Date.now(),
    ...(clientAddress ? { clientAddress } : {}),
    payload: { email, password: 'owned-registration-evidence-password' },
  };
}
async function assertEmpty() {
  expect(await environment.ownerDatabase.select().from(users)).toEqual([]);
  expect(await environment.ownerDatabase.select().from(userCredentials)).toEqual([]);
  expect(await environment.ownerDatabase.select().from(authPasswordChangeEvidence)).toEqual([]);
  expect(await environment.ownerDatabase.select().from(authEmailVerificationTokens)).toEqual([]);
  expect(await environment.ownerDatabase.select().from(mobileRefreshTokens)).toEqual([]);
}
async function assertCaptured(email: string) {
  const [account] = await environment.ownerDatabase.select().from(users).where(eq(users.email, email));
  const [credential] = await environment.ownerDatabase
    .select()
    .from(userCredentials)
    .where(eq(userCredentials.userId, account.id));
  const [evidence] = await environment.ownerDatabase
    .select()
    .from(authPasswordChangeEvidence)
    .where(eq(authPasswordChangeEvidence.userId, account.id));
  expect(evidence.passwordFingerprint).toBe(passwordFingerprint(credential.passwordHash));
  expect(evidence.changedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  return { userId: account.id, evidence };
}

describe('registration and evidence on the exact narrow default credential path', () => {
  beforeAll(async () => {
    const target = ownedCredentialProofUrl();
    const template = target.pathname.slice(1);
    target.pathname = '/postgres';
    admin = postgres(target.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${copyName}" TEMPLATE "${template}"`);
    environment = await createCredentialWriterEnvironment('private-registration-evidence-v1', {
      copyDatabase: copyName,
    });
    server = createServer((request, response) => {
      const pending =
        request.url === '/auth/native/register'
          ? handleNativeAuthRegister(request, response)
          : handleCurrentStoreRegistration(request, response);
      void pending.catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned registration evidence binding failed');
    origin = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(async () => {
    await closeCredentialDatabase();
    await environment.resetGrants();
    // Only this random suite-owned template copy is reset; canonical remains intact.
    await environment.owner`DELETE FROM users`;
    await environment.owner.unsafe(
      'TRUNCATE auth_email_projection,auth_email_verification_state,auth_subject_cutoffs,"verificationTokens" CASCADE',
    );
    for (const [name, setting] of Object.entries({
      DATABASE_URL: environment.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
      AUTH_IDENTITY_DATABASE_CONTRACT: 'private-registration-evidence-v1',
      AUTH_PASSWORD_CHANGE_EVIDENCE_MODE: 'on',
      CURRENT_STORE_AUTH_RPC_SECRET: secret,
      CURRENT_STORE_WEB_AUTH_MODE: 'legacy',
      CURRENT_STORE_NATIVE_REGISTRATION_MODE: 'legacy',
      EMAIL_VERIFICATION_ENABLED: 'true',
      NEXTAUTH_SECRET: 'owned-registration-evidence-jwt-secret-6975',
      AUTH_IDENTITY_MIRROR: 'off',
      DEBUG_SQL: 'false',
    }))
      vi.stubEnv(name, setting);
    __resetNativeAuthStateForTests();
  });
  afterEach(async () => {
    await closeCredentialDatabase();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await environment?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${copyName}"`);
      await admin.end();
    }
  });

  it('qualifies the real pre-listen narrow profile without direct revocation or silent provider elevation', async () => {
    await expect(qualifyPasswordChangeEvidenceAtStartup()).resolves.toBeUndefined();
    expect(
      (
        await qualifyCredentialWriter(environment.writer, {
          expectedRole: 'boardsesh_identity_writer',
          expectedDatabase: copyName,
          contract: 'private-registration-evidence-v1',
        })
      ).contract,
    ).toBe('private-registration-evidence-v1');
    await expect(getCredentialDatabase('private-registration-v1')).resolves.toBeDefined();
    await expect(getCredentialDatabase('private-provider-v1')).rejects.toThrow(
      'CREDENTIAL_DATABASE_CAPABILITY_REQUIRED',
    );
    await expect(environment.writer`SELECT public.partner_revoke_user('owned-unused-user')`).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      qualifyCredentialWriter(environment.writer, {
        expectedRole: 'boardsesh_identity_writer',
        expectedDatabase: copyName,
        contract: 'private-registration-v1',
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT' });
    await assertEmpty();
  });

  it.each([false, true])(
    'captures real private registration and UID receipt atomically before enforcement, prepared=%s',
    async (prepared) => {
      if (prepared)
        await environment.ownerDatabase.transaction((transaction) =>
          prepareProjectionUnderUsersTableLock(transaction, { projectionId: randomUUID() }),
        );
      await qualifyPasswordChangeEvidenceAtStartup();
      const email = `web-${randomUUID()}@example.invalid`;
      const response = await post(command(email));
      expect(response.status).toBe(201);
      expect(registerReplySchema.parse(response.body).outcome).toBe('created');
      const account = await assertCaptured(email);
      expect(
        await environment.ownerDatabase
          .select()
          .from(authEmailVerificationTokens)
          .where(eq(authEmailVerificationTokens.userId, account.userId)),
      ).toHaveLength(1);
      expect(await environment.ownerDatabase.select().from(mobileRefreshTokens)).toEqual([]);
      const repeated = await post(command(email));
      expect(repeated.status).toBe(409);
      expect(await environment.ownerDatabase.select().from(authPasswordChangeEvidence)).toEqual([account.evidence]);
    },
  );

  it('captures registration through the new authenticated client-context envelope too', async () => {
    await qualifyPasswordChangeEvidenceAtStartup();
    const email = `vouched-${randomUUID()}@example.invalid`;
    // This fixture's authenticated service supplies synthetic public context;
    // requests stay on loopback and carry no browser Origin/forwarding claim.
    const response = await post(command(email, '8.8.4.4'));
    expect(response.status).toBe(201);
    await assertCaptured(email);
  });

  it('aborts private registration and UID receipts on a real evidence CHECK failure', async () => {
    await qualifyPasswordChangeEvidenceAtStartup();
    await environment.owner`ALTER TABLE auth_password_change_evidence ADD CONSTRAINT owned_registration_evidence_reject CHECK (false) NOT VALID`;
    try {
      expect((await post(command(`check-${randomUUID()}@example.invalid`))).status).toBe(503);
    } finally {
      await environment.owner`ALTER TABLE auth_password_change_evidence DROP CONSTRAINT owned_registration_evidence_reject`;
    }
    await assertEmpty();
  });

  it('captures default native registration, UID receipt and refresh on the same narrow LOGIN', async () => {
    await qualifyPasswordChangeEvidenceAtStartup();
    const email = `native-${randomUUID()}@example.invalid`;
    const response = await post({ email, password: 'owned-registration-evidence-password' }, true);
    expect(response.status).toBe(201);
    expect(response.body.jwt).toBeTruthy();
    expect(response.body.refreshToken).toBeTruthy();
    const account = await assertCaptured(email);
    expect(
      await environment.ownerDatabase
        .select()
        .from(authEmailVerificationTokens)
        .where(eq(authEmailVerificationTokens.userId, account.userId)),
    ).toHaveLength(1);
    expect(
      await environment.ownerDatabase
        .select()
        .from(mobileRefreshTokens)
        .where(eq(mobileRefreshTokens.userId, account.userId)),
    ).toHaveLength(1);
  });

  it('serializes the real private/native registration race with one captured password', async () => {
    const email = `race-${randomUUID()}@example.invalid`;
    const responses = await Promise.all([
      post(command(email)),
      post({ email: email.toUpperCase(), password: 'owned-registration-evidence-password' }, true),
    ]);
    expect(responses.map((response) => response.status).sort((left, right) => left - right)).toEqual([201, 409]);
    await assertCaptured(email);
    expect(await environment.ownerDatabase.select().from(users)).toHaveLength(1);
    expect(await environment.ownerDatabase.select().from(authPasswordChangeEvidence)).toHaveLength(1);
  });

  it('rolls native identity, evidence and UID receipt back when refresh persistence fails', async () => {
    await qualifyPasswordChangeEvidenceAtStartup();
    await environment.owner`ALTER TABLE mobile_refresh_tokens ADD CONSTRAINT owned_registration_refresh_reject CHECK (false) NOT VALID`;
    try {
      expect(
        (
          await post(
            { email: `refresh-${randomUUID()}@example.invalid`, password: 'owned-registration-evidence-password' },
            true,
          )
        ).status,
      ).toBe(503);
    } finally {
      await environment.owner`ALTER TABLE mobile_refresh_tokens DROP CONSTRAINT owned_registration_refresh_reject`;
    }
    await assertEmpty();
  });

  it('refuses on-mode startup and private writes with the old registration profile', async () => {
    vi.stubEnv('AUTH_IDENTITY_DATABASE_CONTRACT', 'private-registration-v1');
    await expect(qualifyPasswordChangeEvidenceAtStartup()).rejects.toThrow(
      'CREDENTIAL_DATABASE_CONFIGURATION_REQUIRED',
    );
    expect((await post(command(`old-profile-${randomUUID()}@example.invalid`))).status).toBe(503);
    await assertEmpty();
  });

  it('explicitly supports registration from the broader evidence profile when provisioned', async () => {
    await grantOwnedCredentialWriterCapabilities(environment.owner, 'private-password-evidence-v1');
    vi.stubEnv('AUTH_IDENTITY_DATABASE_CONTRACT', 'private-password-evidence-v1');
    await qualifyPasswordChangeEvidenceAtStartup();
    const email = `broad-${randomUUID()}@example.invalid`;
    expect((await post(command(email))).status).toBe(201);
    await assertCaptured(email);
  });
});
