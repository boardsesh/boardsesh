import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { qualifyCredentialWriter, type CredentialWriterContract } from '@boardsesh/db/credential-writer-acl';
import {
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authFirstPasswordChallenges,
  users,
} from '@boardsesh/db/schema/auth';
import { createCredentialWriterEnvironment } from './fixtures/credential-writer-environment';
import { createProviderSecurityDriver } from './provider-security-fixture';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { captureIdentityAuthority, switchIdentityAuthority } from '../router';
import { captureFirstPasswordRuntime } from '../first-password-policy';
import { requestFirstPasswordChallenge, readFirstPasswordChallenge } from '../first-password-challenges';
import {
  prepareFirstPasswordChallenge,
  finalizeFirstPasswordChallenge,
  acknowledgeFirstPasswordResult,
} from '../first-password-finalizer';
import { normalizeAccountEmail } from '../../normalize-email';
import { runFirstPasswordPreparationMaintenance } from '../first-password-maintenance';
import { closeCredentialDatabase, getCredentialDatabase } from '../../credential-database';

let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
let projectionId: string = randomUUID();
const qualify = (contract: CredentialWriterContract = 'private-first-password-v1') =>
  qualifyCredentialWriter(environment.writer, {
    expectedRole: 'boardsesh_identity_writer',
    expectedDatabase: environment.databaseName,
    contract,
  });
async function drift(apply: string, restore: string, code: string) {
  await environment.owner.unsafe(apply);
  try {
    await expect(qualify()).rejects.toMatchObject({ code });
  } finally {
    await environment.owner.unsafe(restore);
  }
  expect((await qualify()).contract).toBe('private-first-password-v1');
}
describe('private-first-password-v1 canonical0314 restricted LOGIN closure', () => {
  beforeAll(async () => {
    environment = await createCredentialWriterEnvironment('private-first-password-v1');
    await environment.ownerDatabase.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(authEmailProjection)
        .where(eq(authEmailProjection.isCurrent, true));
      if (existing) {
        if (existing.phase !== 'enforced') throw new Error('Owned first-password proof needs enforced projection');
        projectionId = existing.projectionId;
      } else {
        await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
        await transaction
          .update(authEmailProjection)
          .set({ phase: 'enforced' })
          .where(eq(authEmailProjection.projectionId, projectionId));
      }
    });
  });
  afterAll(async () => environment?.close());
  it('qualifies the exact new relation/FK on an authenticated writer and its physical transaction', async () => {
    const receipt = await qualify();
    expect(receipt.contract).toBe('private-first-password-v1');
    await environment.writer.begin(async (transaction) => {
      expect(
        await qualifyCredentialWriter(transaction, {
          expectedRole: 'boardsesh_identity_writer',
          expectedDatabase: environment.databaseName,
          contract: 'private-first-password-v1',
        }),
      ).toEqual(receipt);
      const [identity] = await transaction`SELECT current_user AS role, session_user AS login`;
      expect(identity).toEqual({ role: 'boardsesh_identity_writer', login: 'boardsesh_identity_writer' });
    });
  });
  it('keeps old provider capability closed and requires every new grant explicitly', async () => {
    await expect(qualify('private-provider-v1')).rejects.toMatchObject({
      code: 'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    });
    await environment.owner`REVOKE SELECT,INSERT,UPDATE ON auth_first_password_challenges FROM boardsesh_identity_writer`;
    try {
      expect((await qualify('private-provider-v1')).contract).toBe('private-provider-v1');
      await expect(qualify()).rejects.toMatchObject({ code: 'CREDENTIAL_WRITER_REQUIRED_GRANT_MISSING' });
    } finally {
      await environment.owner`GRANT SELECT,INSERT,UPDATE ON auth_first_password_challenges TO boardsesh_identity_writer`;
    }
    expect((await qualify()).contract).toBe('private-first-password-v1');
  });
  it('refuses actual account/challenge deletion and raw partner issuance/read/update', async () => {
    for (const statement of [
      'DELETE FROM users WHERE false',
      'DELETE FROM auth_first_password_challenges WHERE false',
      'INSERT INTO oauth_refresh_token DEFAULT VALUES',
      'SELECT token FROM oauth_refresh_token WHERE false',
      'UPDATE oauth_connections SET user_id=user_id WHERE false',
    ])
      await expect(environment.writer.unsafe(statement)).rejects.toMatchObject({ code: '42501' });
    expect((await qualify()).contract).toBe('private-first-password-v1');
  });
  it.each(['DELETE', 'TRUNCATE', 'MAINTAIN'] as const)(
    'rejects excess new-relation %s rather than inheriting maintenance',
    async (privilege) => {
      await drift(
        `GRANT ${privilege} ON auth_first_password_challenges TO boardsesh_identity_writer`,
        `REVOKE ${privilege} ON auth_first_password_challenges FROM boardsesh_identity_writer`,
        'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
      );
    },
  );
  it('refuses PUBLIC and grant-option access to pending bcrypt material', async () => {
    await drift(
      'GRANT SELECT ON auth_first_password_challenges TO PUBLIC',
      'REVOKE SELECT ON auth_first_password_challenges FROM PUBLIC',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
    await drift(
      'GRANT SELECT(pending_password_hash) ON auth_first_password_challenges TO PUBLIC',
      'REVOKE SELECT(pending_password_hash) ON auth_first_password_challenges FROM PUBLIC',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
    await drift(
      'GRANT SELECT ON auth_first_password_challenges TO boardsesh_identity_writer WITH GRANT OPTION',
      'REVOKE GRANT OPTION FOR SELECT ON auth_first_password_challenges FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
  });
  it('pins the exact deletion FK and refuses a changed pending phase default', async () => {
    await drift(
      'ALTER TABLE auth_first_password_challenges DROP CONSTRAINT auth_first_password_challenges_user_id_users_id_fk',
      'ALTER TABLE auth_first_password_challenges ADD CONSTRAINT auth_first_password_challenges_user_id_users_id_fk FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE',
      'CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE',
    );
    await drift(
      "ALTER TABLE auth_first_password_challenges ALTER COLUMN phase SET DEFAULT 'prepared'",
      "ALTER TABLE auth_first_password_challenges ALTER COLUMN phase SET DEFAULT 'pending'",
      'CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE',
    );
  });
  for (const selected of ['current-store', 'better-auth'] as const) {
    it(`${selected}: executes issue/read/prepare/finalize/exactACK on the restricted LOGIN with original known age`, async () => {
      const qualification = {
        expectedProjectionId: projectionId,
        expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      };
      await environment.ownerDatabase.transaction(async (transaction) => {
        const receipt = await captureIdentityAuthority(transaction, qualification);
        if (receipt.authority !== selected)
          await switchIdentityAuthority(transaction, {
            projectionId,
            epoch: receipt.epoch,
            from: receipt.authority,
            to: selected,
          });
      });
      const providerRuntime = {
        qualification,
        legacySecret: 'first-password-restricted-owned-cookie-key',
        methods: {
          configuredProviders: ['google', 'apple'] as const,
          googleAudience: 'owned-google-client',
          googleReauthenticationEnabled: true,
        },
      };
      const driver = await createProviderSecurityDriver({ database: environment.database, runtime: providerRuntime });
      const owner = await driver.actor(selected, selected === 'current-store' ? 'legacy-jwe' : 'canonical-token', {
        password: false,
        provider: 'apple',
      });
      const [user] = await environment.ownerDatabase.select().from(users).where(eq(users.id, owner.userId));
      const normalizedEmail = normalizeAccountEmail(user.email);
      await environment.database
        .insert(authEmailReservations)
        .values({ normalizedEmail, basisProjectionId: projectionId, state: 'owned', ownerUserId: owner.userId });
      await environment.database.insert(authEmailReservationMembers).values({ normalizedEmail, userId: owner.userId });
      const runtime = captureFirstPasswordRuntime({
        qualification,
        legacySecret: providerRuntime.legacySecret,
        emailBindingKey: 'first-password-restricted-private-rpc-key-6975',
      });
      const issued = await requestFirstPasswordChallenge(environment.database, runtime, { actor: owner.actor });
      const bound = {
        actor: owner.actor,
        challengeToken: issued.challengeToken,
        browserIntentToken: issued.browserIntentToken,
      };
      expect((await readFirstPasswordChallenge(environment.database, runtime, bound)).outcome).toBe('pending');
      const prepared = await prepareFirstPasswordChallenge(environment.database, runtime, {
        ...bound,
        confirmationToken: issued.mailPlan.token,
        password: ' first restricted password ',
        confirmPassword: ' first restricted password ',
      });
      expect(prepared.credentialProof.authenticatedAt).toBe(owner.authenticatedAt?.toISOString());
      expect(prepared.credentialProof.authSessionId).toBe(owner.sid);
      const candidate = await driver.candidate(prepared, owner.actor.kind);
      const command = { ...bound, ...prepared, candidate, recoveryToken: issued.recoveryToken };
      const committed = await finalizeFirstPasswordChallenge(environment.database, runtime, command);
      expect(committed.outcome).toBe('committed');
      expect(await acknowledgeFirstPasswordResult(environment.database, runtime, command)).toMatchObject({
        outcome: 'recovered',
        candidateCredentialHash: committed.candidateCredentialHash,
      });
      const [challenge] = await environment.database
        .select()
        .from(authFirstPasswordChallenges)
        .where(eq(authFirstPasswordChallenges.userId, owner.userId));
      expect(challenge).toMatchObject({ phase: 'committed', pendingPasswordHash: null });
      expect((await qualify()).contract).toBe('private-first-password-v1');
    });
  }
  it('scrubs expired material through the same actual profile4 factory after the first-password feature switches off', async () => {
    const userId = randomUUID();
    const now = new Date();
    const issuedAt = new Date(now.getTime() - 360_000);
    const challengeHash = randomBytes(32).toString('hex');
    const digest = () => randomBytes(32).toString('hex');
    await environment.database.insert(users).values({ id: userId, email: `${userId}@example.test` });
    await environment.database.insert(authFirstPasswordChallenges).values({
      challengeHash,
      purpose: 'first-password',
      operationId: randomUUID(),
      userId,
      emailBindingHash: digest(),
      confirmationTokenHash: digest(),
      recoveryTokenHash: digest(),
      actorCredentialKind: 'canonical-token',
      actorCredentialHash: digest(),
      actorSessionId: randomUUID(),
      actorGeneration: 0,
      actorAuthenticatedAt: null,
      actorLinkGuarded: false,
      actorRequiresAccountCutoff: false,
      actorExpiresAt: new Date(now.getTime() + 3_600_000),
      browserBindingHash: digest(),
      browserVersion: 1,
      browserIntentHash: digest(),
      browserBindingExpiresAt: new Date(now.getTime() + 3_600_000),
      projectionId,
      normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      writerAuthority: 'current-store',
      writerEpoch: 1,
      phase: 'prepared',
      issuedAt,
      expiresAt: new Date(now.getTime() - 60_000),
      pendingPasswordHash: await hash(' abandoned first password ', 4),
      preparedAt: new Date(issuedAt.getTime() + 1000),
      preparationTokenHash: digest(),
      proposedCredentialHash: digest(),
    });
    const configuration = {
      CURRENT_STORE_FIRST_PASSWORD_MODE: 'legacy',
      AUTH_IDENTITY_DATABASE_CONTRACT: 'private-first-password-v1',
      CURRENT_STORE_AUTH_PROJECTION_ID: projectionId,
      CURRENT_STORE_AUTH_WRITER_EPOCH: '1',
      CURRENT_STORE_DELETED_EMAIL_KEY: 'owned-scrub-unrelated-deleted-email-key',
      AUTH_CUTOFF_ENFORCEMENT: 'enforce',
      DEBUG_SQL: 'false',
      DATABASE_URL: environment.legacyUrl,
      AUTH_IDENTITY_DATABASE_URL: environment.writerUrl,
    };
    for (const [name, content] of Object.entries(configuration)) vi.stubEnv(name, content);
    try {
      const writer = await getCredentialDatabase('private-first-password-v1');
      expect(await runFirstPasswordPreparationMaintenance(configuration)).toEqual({ observed: 1, scrubbed: 1 });
      for (const contract of ['private-web-v1', 'private-browser-v1', 'private-provider-v1'] as const)
        expect(await getCredentialDatabase(contract)).toBe(writer);
      const [challenge] = await environment.database
        .select()
        .from(authFirstPasswordChallenges)
        .where(eq(authFirstPasswordChallenges.challengeHash, challengeHash));
      expect(challenge).toMatchObject({ phase: 'terminal', pendingPasswordHash: null });
      await expect(environment.writer`DELETE FROM auth_first_password_challenges WHERE false`).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await closeCredentialDatabase();
      vi.unstubAllEnvs();
    }
  });
});
