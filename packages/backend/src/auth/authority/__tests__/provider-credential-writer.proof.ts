import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { executeFirstRow } from '@boardsesh/db/client';
import {
  qualifyCredentialWriter,
  PRIVATE_PROVIDER_CREDENTIAL_CAPABILITIES,
  PRIVATE_BROWSER_CREDENTIAL_CAPABILITIES,
  PRIVATE_PROVIDER_CREDENTIAL_COLUMN_CAPABILITIES,
  PRIVATE_WEB_CREDENTIAL_COLUMN_CAPABILITIES,
  type CredentialWriterContract,
} from '@boardsesh/db/credential-writer-acl';
import {
  authProviderReauthenticationReceipts,
  authProviderSecurityIntents,
  authSecurityMutationEvents,
  oauthAccessToken,
  oauthClient,
  oauthConnections,
  oauthConsent,
  oauthConsentInteractions,
  oauthGrants,
  oauthRefreshAncestors,
  oauthRefreshToken,
  oauthSession,
  oauthVerification,
  users,
} from '@boardsesh/db/schema/auth';
import { createCredentialWriterEnvironment } from './fixtures/credential-writer-environment';

let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
const digest = () => randomBytes(32).toString('hex');
const qualify = (contract: CredentialWriterContract = 'private-provider-v1') =>
  qualifyCredentialWriter(environment.writer, {
    expectedRole: 'boardsesh_identity_writer',
    expectedDatabase: environment.databaseName,
    contract,
  });
async function drift(apply: string, restore: string | readonly string[], code: string) {
  await environment.owner.unsafe(apply);
  try {
    await expect(qualify()).rejects.toMatchObject({ code });
  } finally {
    for (const statement of typeof restore === 'string' ? [restore] : restore)
      await environment.owner.unsafe(statement);
  }
  expect((await qualify()).contract).toBe('private-provider-v1');
}
async function extensionGrants(enabled: boolean) {
  const action = enabled ? 'GRANT' : 'REVOKE';
  const direction = enabled ? 'TO' : 'FROM';
  await environment.owner.begin(async (transaction) => {
    for (const [table, privileges] of Object.entries(PRIVATE_PROVIDER_CREDENTIAL_CAPABILITIES)) {
      if (table in PRIVATE_BROWSER_CREDENTIAL_CAPABILITIES) continue;
      await transaction.unsafe(
        `${action} ${privileges.join(',')} ON public."${table}" ${direction} boardsesh_identity_writer`,
      );
    }
    for (const [table, columns] of Object.entries(PRIVATE_PROVIDER_CREDENTIAL_COLUMN_CAPABILITIES)) {
      if (table in PRIVATE_WEB_CREDENTIAL_COLUMN_CAPABILITIES) continue;
      for (const [column, privileges] of Object.entries(columns))
        await transaction.unsafe(
          `${action} ${privileges.map((privilege) => `${privilege} ("${column}")`).join(',')} ON public."${table}" ${direction} boardsesh_identity_writer`,
        );
    }
    await transaction.unsafe(
      `${action} EXECUTE ON FUNCTION public.partner_revoke_user(text) ${direction} boardsesh_identity_writer`,
    );
  });
}
async function seedPartnerUser() {
  const userId = randomUUID();
  const clientId = randomUUID();
  const connectionId = randomUUID();
  const sessionId = randomUUID();
  const refreshId = randomUUID();
  const codeId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 3_600_000);
  const database = environment.ownerDatabase;
  await database.insert(users).values({ id: userId, email: `${userId}@example.invalid` });
  await database
    .insert(oauthClient)
    .values({ id: clientId, clientId, redirectUris: ['https://owned.example.invalid/callback'] });
  await database.insert(oauthConnections).values({ id: connectionId, userId, clientId });
  await database.insert(oauthSession).values({ id: sessionId, token: randomUUID(), userId, expiresAt, updatedAt: now });
  await database.insert(oauthRefreshToken).values({
    id: refreshId,
    token: randomUUID(),
    userId,
    clientId,
    sessionId,
    authorizationCodeId: codeId,
    expiresAt,
    createdAt: now,
    scopes: ['profile'],
  });
  await database.insert(oauthAccessToken).values({
    id: randomUUID(),
    token: randomUUID(),
    userId,
    clientId,
    sessionId,
    refreshId,
    authorizationCodeId: codeId,
    expiresAt,
    createdAt: now,
    scopes: ['profile'],
  });
  await database
    .insert(oauthConsent)
    .values({ id: randomUUID(), userId, clientId, scopes: ['profile'], createdAt: now, updatedAt: now });
  await database
    .insert(oauthRefreshAncestors)
    .values({ tokenHash: digest(), userId, clientId, authorizationCodeId: codeId, expiresAt });
  await database
    .insert(oauthConsentInteractions)
    .values({ digest: digest(), userId, clientId, authSessionId: randomUUID(), connectionGeneration: 0, expiresAt });
  await database
    .insert(oauthVerification)
    .values({ id: randomUUID(), identifier: codeId, value: 'owned-code-payload', expiresAt });
  await database.insert(oauthGrants).values({ authorizationCodeId: codeId, connectionId, generation: 0 });
  return { userId, clientId, connectionId, codeId };
}
async function partnerSnapshot(owner: Awaited<ReturnType<typeof seedPartnerUser>>) {
  const database = environment.ownerDatabase;
  return Promise.all([
    database.select().from(oauthConnections).where(eq(oauthConnections.userId, owner.userId)),
    database.select().from(oauthVerification).where(eq(oauthVerification.identifier, owner.codeId)),
    database.select().from(oauthGrants).where(eq(oauthGrants.connectionId, owner.connectionId)),
    database.select().from(oauthAccessToken).where(eq(oauthAccessToken.userId, owner.userId)),
    database.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.userId, owner.userId)),
    database.select().from(oauthConsent).where(eq(oauthConsent.userId, owner.userId)),
    database.select().from(oauthRefreshAncestors).where(eq(oauthRefreshAncestors.userId, owner.userId)),
    database.select().from(oauthConsentInteractions).where(eq(oauthConsentInteractions.userId, owner.userId)),
    database.select().from(oauthSession).where(eq(oauthSession.userId, owner.userId)),
  ]);
}
async function revokeAndStoreReceipts(userId: string, rejectAfterWrites: boolean) {
  const intentHash = digest();
  const receiptHash = digest();
  const operationId = randomUUID();
  const pending = environment.database.transaction(async (transaction) => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    await transaction.insert(authProviderSecurityIntents).values({
      intentHash,
      operationId,
      userId,
      actorCredentialKind: 'canonical-token',
      actorCredentialHash: digest(),
      recoveryTokenHash: digest(),
      browserBindingHash: digest(),
      browserVersion: 0,
      browserIntentHash: digest(),
      browserBindingExpiresAt: expiresAt,
      actorSessionId: randomUUID(),
      actorGeneration: 0,
      actorLinkGuarded: false,
      actorRequiresAccountCutoff: false,
      actorExpiresAt: expiresAt,
      operation: 'link',
      provider: 'google',
      projectionId: 'owned-provider-catalog-proof',
      normalizerVersion: 'js-trim-lower-v1',
      writerAuthority: 'current-store',
      writerEpoch: 1,
      issuedAt: now,
      expiresAt,
    });
    await transaction.insert(authProviderReauthenticationReceipts).values({
      receiptHash,
      intentHash,
      method: 'password',
      proofBindingHash: digest(),
      authenticatedAt: now,
      proofExpiresAt: expiresAt,
      issuedAt: now,
      expiresAt,
    });
    const revoked = await executeFirstRow<{ count: number }>(
      transaction,
      sql`SELECT public.partner_revoke_user(${userId}::text) AS count`,
    );
    expect(revoked?.count).toBe(1);
    await transaction
      .update(authProviderSecurityIntents)
      .set({ phase: 'terminal', consumedAt: now })
      .where(eq(authProviderSecurityIntents.intentHash, intentHash));
    await transaction
      .update(authProviderReauthenticationReceipts)
      .set({ consumedAt: now })
      .where(eq(authProviderReauthenticationReceipts.receiptHash, receiptHash));
    await transaction.insert(authSecurityMutationEvents).values({
      operationId,
      userId,
      generation: 1,
      previousGeneration: 0,
      kind: 'provider-link',
      domains: ['first-party', 'partner'],
      revokedThrough: now,
      writerEpoch: 1,
      projectionId: 'owned-provider-catalog-proof',
    });
    if (rejectAfterWrites) throw new Error('OWNED_PROVIDER_LATE_ROLLBACK');
    return { intentHash, receiptHash, operationId };
  });
  return { pending, intentHash, receiptHash, operationId };
}

describe('private-provider-v1 on the actual restricted credential LOGIN', () => {
  beforeAll(async () => {
    environment = await createCredentialWriterEnvironment('private-provider-v1');
  });
  afterAll(async () => {
    await environment?.close();
  });

  it('qualifies the exact 0313 profile and physical transaction principal', async () => {
    const receipt = await qualify();
    expect(receipt).toMatchObject({
      contract: 'private-provider-v1',
      role: 'boardsesh_identity_writer',
      sessionRole: 'boardsesh_identity_writer',
    });
    await environment.writer.begin(async (transaction) => {
      expect(
        await qualifyCredentialWriter(transaction, {
          expectedRole: 'boardsesh_identity_writer',
          expectedDatabase: environment.databaseName,
          contract: 'private-provider-v1',
        }),
      ).toEqual(receipt);
      const [principal] = await transaction`SELECT current_user AS role,session_user AS session_role`;
      expect(principal).toEqual({ role: 'boardsesh_identity_writer', session_role: 'boardsesh_identity_writer' });
    });
  });

  it('does not silently expand old profiles for provider grants or the nine-kind 0313 shape', async () => {
    for (const contract of ['private-web-v1', 'private-browser-v1'] as const)
      await expect(qualify(contract)).rejects.toMatchObject({ code: 'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT' });
    await extensionGrants(false);
    try {
      await expect(qualify('private-browser-v1')).rejects.toMatchObject({
        code: 'CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE',
      });
      await environment.owner`REVOKE SELECT,INSERT,UPDATE ON public.auth_browser_bindings,public.auth_browser_intents FROM boardsesh_identity_writer`;
      try {
        await expect(qualify('private-web-v1')).rejects.toMatchObject({
          code: 'CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE',
        });
      } finally {
        await environment.owner`GRANT SELECT,INSERT,UPDATE ON public.auth_browser_bindings,public.auth_browser_intents TO boardsesh_identity_writer`;
      }
    } finally {
      await extensionGrants(true);
    }
    expect((await qualify()).contract).toBe('private-provider-v1');
  });

  it('requires explicit nongrantable direct revocation EXECUTE and refuses PUBLIC or overload alternatives', async () => {
    await drift(
      'REVOKE EXECUTE ON FUNCTION public.partner_revoke_user(text) FROM boardsesh_identity_writer',
      'GRANT EXECUTE ON FUNCTION public.partner_revoke_user(text) TO boardsesh_identity_writer',
      'CREDENTIAL_WRITER_REQUIRED_ROUTINE_GRANT_MISSING',
    );
    await drift(
      'GRANT EXECUTE ON FUNCTION public.partner_revoke_user(text) TO PUBLIC',
      'REVOKE EXECUTE ON FUNCTION public.partner_revoke_user(text) FROM PUBLIC',
      'CREDENTIAL_WRITER_UNREVIEWED_ROUTINE_PATH',
    );
    await drift(
      'GRANT EXECUTE ON FUNCTION public.partner_revoke_user(text) TO boardsesh_identity_writer WITH GRANT OPTION',
      'REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION public.partner_revoke_user(text) FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_UNREVIEWED_ROUTINE_PATH',
    );
    await drift(
      'CREATE FUNCTION public.partner_revoke_user(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 0 $$',
      'DROP FUNCTION public.partner_revoke_user(integer)',
      'CREDENTIAL_WRITER_UNREVIEWED_ROUTINE_PATH',
    );
  });
  it('pins the direct callee strict invoker contract and forbids other app execution', async () => {
    await drift(
      'ALTER FUNCTION public.partner_revoke_user(text) CALLED ON NULL INPUT',
      'ALTER FUNCTION public.partner_revoke_user(text) RETURNS NULL ON NULL INPUT',
      'CREDENTIAL_WRITER_UNREVIEWED_ROUTINE_PATH',
    );
    await drift(
      'ALTER FUNCTION public.partner_revoke_user(text) SECURITY DEFINER',
      'ALTER FUNCTION public.partner_revoke_user(text) SECURITY INVOKER',
      'CREDENTIAL_WRITER_UNREVIEWED_PARTNER_REVOKE',
    );
    await drift(
      'GRANT EXECUTE ON FUNCTION public.partner_revoke_on_credential_change() TO boardsesh_identity_writer',
      'REVOKE EXECUTE ON FUNCTION public.partner_revoke_on_credential_change() FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_UNREVIEWED_ROUTINE_PATH',
    );
  });

  for (const relation of ['auth_provider_security_intents', 'auth_provider_reauthentication_receipts']) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE'])
      it(`requires ${relation} ${privilege}`, async () =>
        drift(
          `REVOKE ${privilege} ON public.${relation} FROM boardsesh_identity_writer`,
          `GRANT ${privilege} ON public.${relation} TO boardsesh_identity_writer`,
          'CREDENTIAL_WRITER_REQUIRED_GRANT_MISSING',
        ));
    for (const privilege of ['DELETE', 'MAINTAIN'])
      it(`refuses ${relation} ${privilege}`, async () =>
        drift(
          `GRANT ${privilege} ON public.${relation} TO boardsesh_identity_writer`,
          `REVOKE ${privilege} ON public.${relation} FROM boardsesh_identity_writer`,
          'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
        ));
  }
  it('refuses token reads, issuance, extension and whole-table partner grants', async () => {
    for (const [grant, revoke] of [
      ['SELECT ON public.oauth_access_token', 'SELECT ON public.oauth_access_token'],
      ['INSERT ON public.oauth_refresh_token', 'INSERT ON public.oauth_refresh_token'],
      ['UPDATE (expires_at) ON public.oauth_refresh_token', 'UPDATE (expires_at) ON public.oauth_refresh_token'],
      ['SELECT (token) ON public.oauth_access_token', 'SELECT (token) ON public.oauth_access_token'],
      ['SELECT (updated_at) ON public.oauth_connections', 'SELECT (updated_at) ON public.oauth_connections'],
      ['DELETE ON public.oauth_connections', 'DELETE ON public.oauth_connections'],
    ])
      await drift(
        `GRANT ${grant} TO boardsesh_identity_writer`,
        [
          `REVOKE ${revoke} FROM boardsesh_identity_writer`,
          // PostgreSQL also revokes the old column SELECT when table SELECT is
          // revoked. Restore that exact predicate grant, never the whole table.
          ...(grant === 'SELECT ON public.oauth_access_token'
            ? ['GRANT SELECT (user_id) ON public.oauth_access_token TO boardsesh_identity_writer']
            : []),
        ],
        'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
      );
    await expect(environment.writer`SELECT token FROM public.oauth_access_token WHERE false`).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      environment.writer`UPDATE public.oauth_refresh_token SET expires_at=now() WHERE false`,
    ).rejects.toMatchObject({ code: '42501' });
    await expect(environment.writer`SELECT updated_at FROM public.oauth_connections WHERE false`).rejects.toMatchObject(
      { code: '42501' },
    );
    await expect(environment.writer`INSERT INTO public.oauth_refresh_token DEFAULT VALUES`).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      environment.writer`UPDATE public.oauth_connections SET user_id=user_id WHERE false`,
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      environment.writer`UPDATE public.oauth_refresh_token SET token='owned-forbidden-extension' WHERE false`,
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('requires just the callee predicate/read columns without adding SELECT(updated_at)', async () => {
    await drift(
      'REVOKE SELECT (user_id) ON public.oauth_access_token FROM boardsesh_identity_writer',
      'GRANT SELECT (user_id) ON public.oauth_access_token TO boardsesh_identity_writer',
      'CREDENTIAL_WRITER_REQUIRED_COLUMN_GRANT_MISSING',
    );
    await drift(
      'REVOKE UPDATE (updated_at) ON public.oauth_connections FROM boardsesh_identity_writer',
      'GRANT UPDATE (updated_at) ON public.oauth_connections TO boardsesh_identity_writer',
      'CREDENTIAL_WRITER_REQUIRED_COLUMN_GRANT_MISSING',
    );
  });
  it('pins new provider columns and rejects an outgoing cascade escape', async () => {
    await drift(
      'ALTER TABLE public.auth_provider_security_intents ADD COLUMN unexpected_bearer text',
      'ALTER TABLE public.auth_provider_security_intents DROP COLUMN unexpected_bearer',
      'CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE',
    );
    await drift(
      'CREATE TABLE public.provider_cascade_escape(intent_hash text REFERENCES public.auth_provider_security_intents(intent_hash) ON UPDATE CASCADE)',
      'DROP TABLE public.provider_cascade_escape',
      'CREDENTIAL_WRITER_UNREVIEWED_CASCADE_PATH',
    );
  });

  it('revokes every affected partner row and commits provider storage while unrelated credentials remain exact', async () => {
    const affected = await seedPartnerUser();
    const unrelated = await seedPartnerUser();
    const unrelatedBefore = await partnerSnapshot(unrelated);
    const result = await revokeAndStoreReceipts(affected.userId, false);
    await result.pending;
    const after = await partnerSnapshot(affected);
    expect(after[0]).toMatchObject([{ generation: 1, revocationReason: 'account_security_revocation' }]);
    expect(after[0][0].revokedAt).toBeInstanceOf(Date);
    for (const rows of after.slice(1)) expect(rows).toEqual([]);
    expect(await partnerSnapshot(unrelated)).toEqual(unrelatedBefore);
    expect(
      await environment.ownerDatabase
        .select()
        .from(authProviderSecurityIntents)
        .where(eq(authProviderSecurityIntents.intentHash, result.intentHash)),
    ).toMatchObject([{ phase: 'terminal' }]);
    expect(
      await environment.ownerDatabase
        .select()
        .from(authProviderReauthenticationReceipts)
        .where(eq(authProviderReauthenticationReceipts.receiptHash, result.receiptHash)),
    ).toMatchObject([{ consumedAt: expect.any(Date) }]);
  });
  it('rolls the real callee and all provider/event storage back after a late transaction failure', async () => {
    const affected = await seedPartnerUser();
    const unrelated = await seedPartnerUser();
    const affectedBefore = await partnerSnapshot(affected);
    const unrelatedBefore = await partnerSnapshot(unrelated);
    const result = await revokeAndStoreReceipts(affected.userId, true);
    await expect(result.pending).rejects.toThrow('OWNED_PROVIDER_LATE_ROLLBACK');
    expect(await partnerSnapshot(affected)).toEqual(affectedBefore);
    expect(await partnerSnapshot(unrelated)).toEqual(unrelatedBefore);
    expect(
      await environment.ownerDatabase
        .select()
        .from(authProviderSecurityIntents)
        .where(eq(authProviderSecurityIntents.intentHash, result.intentHash)),
    ).toEqual([]);
    expect(
      await environment.ownerDatabase
        .select()
        .from(authProviderReauthenticationReceipts)
        .where(eq(authProviderReauthenticationReceipts.receiptHash, result.receiptHash)),
    ).toEqual([]);
    expect(
      await environment.ownerDatabase
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.operationId, result.operationId)),
    ).toEqual([]);
  });
});
