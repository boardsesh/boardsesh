import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { qualifyCredentialWriter, type CredentialWriterContract } from '@boardsesh/db/credential-writer-acl';
import {
  authBrowserBindings,
  authBrowserIntents,
  authEmailProjection,
  authSession,
  authSubjectCutoffs,
  authSecurityMutationEvents,
  userCredentials,
  users,
} from '@boardsesh/db/schema/auth';
import {
  createCredentialWriterEnvironment,
  grantOwnedCredentialWriterCapabilities,
} from './fixtures/credential-writer-environment';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { transactionSettings } from '../../current-store/command-context';
import { captureIdentityAuthority, switchIdentityAuthority, type IdentityAuthorityName } from '../router';
import { bindIdentityAuthority } from '../identity-authority';
import { recordIdentityPasswordMutation } from '../password-mutation';
import {
  beginBrowserIntent,
  commitBrowserLogin,
  commitBrowserLogout,
  createUnpublishedBrowserBinding,
  readBrowserBinding,
  readBrowserBindingInTransaction,
  prepareBrowserReplacementInTransaction,
  commitPreparedBrowserReplacementInTransaction,
  type BrowserSelectionCredential,
} from '../browser-binding';

const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = requireWeb('next-auth/jwt') as {
  encode(input: { secret: string; maxAge: number; token: Record<string, unknown> }): Promise<string>;
};
const secret = 'owned-restricted-browser-role-source-secret';
let environment: Awaited<ReturnType<typeof createCredentialWriterEnvironment>>;
const qualify = (contract: CredentialWriterContract = 'private-browser-v1') =>
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
  expect((await qualify()).contract).toBe('private-browser-v1');
}
describe('private-browser-v1 on the actual restricted credential LOGIN', () => {
  beforeAll(async () => {
    environment = await createCredentialWriterEnvironment('private-browser-v1');
  });
  afterAll(async () => {
    if (environment) {
      await grantOwnedCredentialWriterCapabilities(environment.owner, 'private-web-v1');
      await environment.close();
    }
    vi.unstubAllEnvs();
  });

  it('qualifies the exact browser profile and retains the authenticated principal in a physical transaction', async () => {
    const receipt = await qualify();
    expect(receipt).toMatchObject({
      contract: 'private-browser-v1',
      role: 'boardsesh_identity_writer',
      sessionRole: 'boardsesh_identity_writer',
    });
    await environment.writer.begin(async (transaction) => {
      expect(
        await qualifyCredentialWriter(transaction, {
          expectedRole: 'boardsesh_identity_writer',
          expectedDatabase: environment.databaseName,
          contract: 'private-browser-v1',
        }),
      ).toEqual(receipt);
    });
  });
  it('keeps old private-web-v1 strict and refuses unknown profile names before catalog access', async () => {
    await expect(qualify('private-web-v1')).rejects.toMatchObject({ code: 'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT' });
    await expect(qualify('private-provider-v1' as CredentialWriterContract)).rejects.toMatchObject({
      code: 'CREDENTIAL_WRITER_CONTRACT_REQUIRED',
    });
    await environment.owner`REVOKE SELECT,INSERT,UPDATE ON public.auth_browser_bindings,public.auth_browser_intents FROM boardsesh_identity_writer`;
    try {
      expect((await qualify('private-web-v1')).contract).toBe('private-web-v1');
      await expect(qualify()).rejects.toMatchObject({ code: 'CREDENTIAL_WRITER_REQUIRED_GRANT_MISSING' });
    } finally {
      await environment.owner`GRANT SELECT,INSERT,UPDATE ON public.auth_browser_bindings,public.auth_browser_intents TO boardsesh_identity_writer`;
    }
  });
  for (const relation of ['auth_browser_bindings', 'auth_browser_intents']) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE'])
      it(`requires ${relation} ${privilege}`, async () =>
        drift(
          `REVOKE ${privilege} ON public.${relation} FROM boardsesh_identity_writer`,
          `GRANT ${privilege} ON public.${relation} TO boardsesh_identity_writer`,
          'CREDENTIAL_WRITER_REQUIRED_GRANT_MISSING',
        ));
    for (const privilege of ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'])
      it(`refuses ${relation} ${privilege} maintenance/escape rights`, async () =>
        drift(
          `GRANT ${privilege} ON public.${relation} TO boardsesh_identity_writer`,
          `REVOKE ${privilege} ON public.${relation} FROM boardsesh_identity_writer`,
          'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
        ));
  }
  it('refuses browser PUBLIC/grant-option/column-reference grants and direct partner execution/DML', async () => {
    await drift(
      'GRANT DELETE ON public.auth_browser_intents TO PUBLIC',
      'REVOKE DELETE ON public.auth_browser_intents FROM PUBLIC',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
    await drift(
      'GRANT UPDATE ON public.auth_browser_bindings TO boardsesh_identity_writer WITH GRANT OPTION',
      'REVOKE GRANT OPTION FOR UPDATE ON public.auth_browser_bindings FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
    await drift(
      'GRANT REFERENCES (user_id) ON public.auth_browser_bindings TO boardsesh_identity_writer',
      'REVOKE REFERENCES (user_id) ON public.auth_browser_bindings FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
    await drift(
      'GRANT EXECUTE ON FUNCTION public.partner_revoke_user(text) TO boardsesh_identity_writer',
      'REVOKE EXECUTE ON FUNCTION public.partner_revoke_user(text) FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_UNREVIEWED_ROUTINE_PATH',
    );
    await drift(
      'GRANT UPDATE (generation) ON public.oauth_connections TO boardsesh_identity_writer',
      'REVOKE UPDATE (generation) ON public.oauth_connections FROM boardsesh_identity_writer',
      'CREDENTIAL_WRITER_EXCESS_RELATION_GRANT',
    );
    await expect(environment.writer`SELECT public.partner_revoke_user('owned-no-user')`).rejects.toMatchObject({
      code: '42501',
    });
  });
  it('pins every0312 browser column, default, index, check and foreign key', async () => {
    await drift(
      'ALTER TABLE public.auth_browser_intents ADD COLUMN unexpected_scope text',
      'ALTER TABLE public.auth_browser_intents DROP COLUMN unexpected_scope',
      'CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE',
    );
    await drift(
      'ALTER TABLE public.auth_browser_intents ALTER COLUMN format_version SET DEFAULT 2',
      'ALTER TABLE public.auth_browser_intents ALTER COLUMN format_version SET DEFAULT 1',
      'CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE',
    );
    await drift(
      'CREATE INDEX browser_unreviewed_index ON public.auth_browser_bindings(user_id)',
      'DROP INDEX public.browser_unreviewed_index',
      'CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE',
    );
    await drift(
      'ALTER TABLE public.auth_browser_intents ADD CONSTRAINT browser_unreviewed_check CHECK (format_version=2)',
      'ALTER TABLE public.auth_browser_intents DROP CONSTRAINT browser_unreviewed_check',
      'CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE',
    );
    const [foreignKey] = await environment.owner<
      { definition: string }[]
    >`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='auth_browser_intents_binding_id_auth_browser_bindings_id_fk'`;
    await drift(
      'ALTER TABLE public.auth_browser_intents DROP CONSTRAINT auth_browser_intents_binding_id_auth_browser_bindings_id_fk',
      `ALTER TABLE public.auth_browser_intents ADD CONSTRAINT auth_browser_intents_binding_id_auth_browser_bindings_id_fk ${foreignKey!.definition}`,
      'CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE',
    );
  });
  it('refuses browser row-policy/rule/trigger/expression/cascade paths', async () => {
    await drift(
      'ALTER TABLE public.auth_browser_bindings ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE public.auth_browser_bindings DISABLE ROW LEVEL SECURITY',
      'CREDENTIAL_WRITER_UNREVIEWED_SHAPE_PATH',
    );
    await drift(
      'CREATE RULE browser_escape_rule AS ON UPDATE TO public.auth_browser_bindings DO ALSO NOTIFY owned_browser_escape',
      'DROP RULE browser_escape_rule ON public.auth_browser_bindings',
      'CREDENTIAL_WRITER_UNREVIEWED_SHAPE_PATH',
    );
    await drift(
      'CREATE TRIGGER browser_escape_trigger BEFORE UPDATE ON public.auth_browser_bindings FOR EACH ROW EXECUTE FUNCTION public.partner_revoke_on_credential_change()',
      'DROP TRIGGER browser_escape_trigger ON public.auth_browser_bindings',
      'CREDENTIAL_WRITER_UNREVIEWED_TRIGGER_PATH',
    );
    await drift(
      "ALTER TABLE public.auth_browser_intents ADD CONSTRAINT browser_notify_check CHECK (pg_notify('owned_browser_escape',id) IS NOT NULL)",
      'ALTER TABLE public.auth_browser_intents DROP CONSTRAINT browser_notify_check',
      'CREDENTIAL_WRITER_UNREVIEWED_RELATION_SHAPE',
    );
    await drift(
      'CREATE TABLE public.browser_cascade_escape(binding_id text REFERENCES public.auth_browser_bindings(id) ON UPDATE CASCADE)',
      'DROP TABLE public.browser_cascade_escape',
      'CREDENTIAL_WRITER_UNREVIEWED_CASCADE_PATH',
    );
  });

  describe('actual browser core commands', () => {
    let userId: string;
    let qualification: { expectedProjectionId: string; expectedNormalizerVersion: string };
    beforeEach(async () => {
      userId = randomUUID();
      qualification = { expectedProjectionId: randomUUID(), expectedNormalizerVersion: 'js-trim-lower-v1' };
      await environment.ownerDatabase.insert(users).values({ id: userId, email: `${userId}@example.invalid` });
      await environment.ownerDatabase.transaction(async (transaction) => {
        const [existing] = await transaction
          .select()
          .from(authEmailProjection)
          .where(eq(authEmailProjection.isCurrent, true));
        if (existing) {
          if (existing.phase !== 'enforced') throw new Error('Owned browser proof requires enforced projection');
          qualification.expectedProjectionId = existing.projectionId;
        } else {
          await prepareProjectionUnderUsersTableLock(transaction, { projectionId: qualification.expectedProjectionId });
          await transaction.update(authEmailProjection).set({ phase: 'enforced' });
        }
      });
      vi.stubEnv('AUTH_IDENTITY_MIRROR', 'on');
    });
    for (const authority of ['current-store', 'better-auth'] as const)
      for (const kind of ['legacy-jwe', 'canonical-token'] as const)
        it(`${authority}: creates, selects, reads, replaces, retries and logs out ${kind} through authenticated LOGIN`, async () => {
          await environment.ownerDatabase.transaction(async (transaction) => {
            const [manifest] = await transaction
              .select()
              .from(authEmailProjection)
              .where(eq(authEmailProjection.isCurrent, true));
            if (manifest.writerAuthority !== authority)
              await switchIdentityAuthority(transaction, {
                projectionId: qualification.expectedProjectionId,
                from: manifest.writerAuthority,
                to: authority as IdentityAuthorityName,
                epoch: manifest.writerEpoch,
              });
          });
          expect((await qualify()).contract).toBe('private-browser-v1');
          const sid = randomUUID();
          const authenticatedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
          const expiresAt = new Date(Date.now() + 3_600_000);
          const source =
            kind === 'legacy-jwe'
              ? {
                  kind,
                  secret,
                  credential: await jwt.encode({
                    secret,
                    maxAge: 3600,
                    token: {
                      sub: userId,
                      authSessionId: sid,
                      gen: 0,
                      auth_time: authenticatedAt.getTime() / 1000,
                      link_guarded: true,
                    },
                  }),
                }
              : { kind, token: randomUUID() };
          if (source.kind === 'canonical-token')
            await environment.ownerDatabase.insert(authSession).values({
              id: sid,
              token: source.token,
              userId,
              expiresAt,
              updatedAt: new Date(),
              revocationGeneration: 0,
              originalAuthenticatedAt: authenticatedAt,
            });
          const created = await createUnpublishedBrowserBinding(
            environment.database,
            qualification,
            new Date(Date.now() + 86_400_000),
          );
          if (created.status !== 'created') throw new Error('Owned role browser init failed');
          const pending = await beginBrowserIntent(environment.database, qualification, created.token, {
            operation: 'login',
            expectedVersion: 0,
          });
          if (pending.status !== 'prepared') throw new Error('Owned role browser intent failed');
          const selected = await commitBrowserLogin(
            environment.database,
            qualification,
            created.token,
            pending.intentToken,
            source,
          );
          if (selected.status !== 'committed' || !selected.session) throw new Error('Owned role browser login failed');
          const actor: BrowserSelectionCredential = { version: 1, credential: source };
          expect((await readBrowserBinding(environment.database, qualification, created.token, actor)).status).toBe(
            'admitted',
          );
          expect(await readBrowserBinding(environment.database, qualification, created.token)).toEqual({
            status: 'denied',
          });
          await environment.database.transaction(async (transaction) => {
            const receipt = await captureIdentityAuthority(transaction, qualification);
            expect(
              (await readBrowserBindingInTransaction(transaction, receipt, { bindingToken: created.token, actor }))
                .status,
            ).toBe('admitted');
          });
          const replacement = await beginBrowserIntent(environment.database, qualification, created.token, {
            operation: 'replacement',
            expectedVersion: 1,
            expectedIdentity: selected.session,
            presented: actor,
          });
          if (replacement.status !== 'prepared') throw new Error('Owned role replacement intent failed');
          const candidate =
            source.kind === 'canonical-token'
              ? { kind: 'canonical-token' as const, token: randomUUID() }
              : {
                  kind: 'legacy-jwe' as const,
                  secret,
                  credential: await jwt.encode({
                    secret,
                    maxAge: 3590,
                    token: {
                      sub: userId,
                      authSessionId: sid,
                      gen: 1,
                      auth_time: authenticatedAt.getTime() / 1000,
                      link_guarded: true,
                    },
                  }),
                };
          const replaced = await environment.database.transaction(async (transaction) => {
            await transactionSettings(transaction);
            const receipt = await captureIdentityAuthority(transaction, qualification);
            const operationId = randomUUID();
            const preparation = await prepareBrowserReplacementInTransaction(transaction, receipt, {
              bindingToken: created.token,
              intentToken: replacement.intentToken,
              actor,
              candidate,
              operationId,
              kind: 'password-set',
            });
            await bindIdentityAuthority(transaction, receipt).insertPassword(
              userId,
              'owned-browser-role-password-hash',
              0,
            );
            const mutation = await recordIdentityPasswordMutation(
              transaction,
              {
                expectedProjectionId: receipt.projectionId,
                expectedNormalizerVersion: receipt.normalizerVersion,
                expectedWriterEpoch: receipt.epoch,
                userId,
                operationId,
                expectedGeneration: 0,
                kind: 'password-set',
                domains: ['first-party', 'partner'],
              },
              receipt,
            );
            if (candidate.kind === 'canonical-token')
              await transaction
                .update(authSession)
                .set({ token: candidate.token, revocationGeneration: 1 })
                .where(eq(authSession.id, sid));
            return commitPreparedBrowserReplacementInTransaction(
              transaction,
              receipt,
              preparation,
              mutation.identityGenerationReceipt,
            );
          });
          expect(replaced).toMatchObject({
            status: 'committed',
            cursor: { version: 2 },
            session: { userId, authSessionId: sid, generation: 1, authenticatedAt },
          });
          expect(
            (await environment.database.select().from(userCredentials).where(eq(userCredentials.userId, userId)))[0]
              ?.passwordHash,
          ).toBe('owned-browser-role-password-hash');
          expect(
            (
              await environment.database
                .select()
                .from(authSecurityMutationEvents)
                .where(eq(authSecurityMutationEvents.userId, userId))
            )[0]?.kind,
          ).toBe('password-set');
          expect(
            (
              await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, userId))
            )[0]?.generation,
          ).toBe(1);
          expect(
            (
              await commitBrowserLogin(
                environment.database,
                qualification,
                created.token,
                replacement.intentToken,
                candidate,
                actor,
              )
            ).status,
          ).toBe('already-committed');
          const currentActor = { version: 2, credential: candidate };
          const logout = await beginBrowserIntent(environment.database, qualification, created.token, {
            operation: 'logout',
            expectedVersion: 2,
            expectedIdentity: replaced.session!,
            presented: currentActor,
          });
          if (logout.status !== 'prepared') throw new Error('Owned role logout intent failed');
          expect(
            (
              await commitBrowserLogout(
                environment.database,
                qualification,
                created.token,
                logout.intentToken,
                currentActor,
              )
            ).status,
          ).toBe('committed');
          expect((await readBrowserBinding(environment.database, qualification, created.token)).status).toBe(
            'anonymous',
          );
          await expect(
            environment.writer`DELETE FROM public.auth_browser_bindings WHERE id=${created.cursor.bindingId}`,
          ).rejects.toMatchObject({ code: '42501' });
          expect(
            (
              await environment.database
                .select()
                .from(authBrowserIntents)
                .where(
                  and(
                    eq(authBrowserIntents.bindingId, created.cursor.bindingId),
                    eq(authBrowserIntents.operation, 'replacement'),
                  ),
                )
            )[0]?.consumedAt,
          ).not.toBeNull();
          expect(
            (
              await environment.database
                .select()
                .from(authBrowserBindings)
                .where(eq(authBrowserBindings.id, created.cursor.bindingId))
            )[0]?.version,
          ).toBe(3);
        });
  });
});
