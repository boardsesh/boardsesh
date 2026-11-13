import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  authBrowserBindings,
  authBrowserIntents,
  authEmailProjection,
  authSession,
  authCredentialLineage,
  authSessionDenials,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  userCredentials,
  authAccount,
  users,
} from '@boardsesh/db/schema/auth';
import { createEnvironment } from './environment';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import {
  beginBrowserIntent,
  commitBrowserLogin as commitBrowserLoginCore,
  commitBrowserLogout as commitBrowserLogoutCore,
  createUnpublishedBrowserBinding,
  readBrowserBinding as readBrowserBindingCore,
  readBrowserBindingInTransaction,
  prepareBrowserReplacementInTransaction,
  commitPreparedBrowserReplacementInTransaction,
  BROWSER_BINDING_PUBLIC_BOOTSTRAP_READY,
  assertBrowserBindingPublicBootstrap,
  type BrowserBindingCommitResult,
  type BrowserSelectionCredential,
  type BrowserReplacementPreparation,
} from '../browser-binding';
import {
  BROWSER_BINDING_COOKIE,
  presentedBrowserBinding,
  serializeBrowserBindingCookie,
} from '../browser-binding-cookie';
import {
  captureIdentityAuthority,
  switchIdentityAuthority,
  type IdentityAuthorityName,
  type IdentityAuthorityReceipt,
} from '../router';
import * as sessionReader from '../session-reader';
import type { FirstPartyCredential } from '../session-reader';
import { readLockedWebSubjectState } from '../../current-store/web-credential-state';
import { bindIdentityAuthority } from '../identity-authority';
import { recordIdentityPasswordMutation } from '../password-mutation';
import {
  recordCheckedSecurityMutation,
  type IdentityGenerationMutationReceipt,
} from '../../current-store/security-mutation-core';
import { transactionSettings } from '../../current-store/command-context';
import type { AuthorityTransaction } from '../adapter';
import * as authorityRouter from '../router';

const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = requireWeb('next-auth/jwt') as {
  encode(input: { secret: string; token: Record<string, unknown>; maxAge: number }): Promise<string>;
};
const secret = 'owned-browser-binding-proof-secret-6975';
const qualification = {
  expectedProjectionId: randomUUID(),
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
};
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let accountA: string;
let accountB: string;

// These are browser-held bytes, captured only from an actual issuance response.
// No fixture reads a token/secret from the database to manufacture possession.
const browserCookies = new Map<string, BrowserSelectionCredential>();
const retainedActors = new Map<string, BrowserSelectionCredential | undefined>();
function copyCredential(presented: BrowserSelectionCredential | undefined) {
  return presented ? { version: presented.version, credential: { ...presented.credential } } : undefined;
}
async function readBrowserBinding(...parameters: Parameters<typeof readBrowserBindingCore>) {
  const [database, expected, token] = parameters;
  return readBrowserBindingCore(database, expected, token, parameters[3] ?? copyCredential(browserCookies.get(token)));
}
async function commitBrowserLogin(...parameters: Parameters<typeof commitBrowserLoginCore>) {
  const [database, expected, token, intentToken, candidate] = parameters;
  const result = await commitBrowserLoginCore(
    database,
    expected,
    token,
    intentToken,
    candidate,
    parameters[5] ?? copyCredential(retainedActors.get(intentToken)),
  );
  if (result.status === 'committed')
    browserCookies.set(token, { version: result.cursor.version, credential: { ...candidate } });
  return result;
}
async function commitBrowserLogout(...parameters: Parameters<typeof commitBrowserLogoutCore>) {
  const [database, expected, token, intentToken] = parameters;
  const result = await commitBrowserLogoutCore(
    database,
    expected,
    token,
    intentToken,
    parameters[4] ?? copyCredential(retainedActors.get(intentToken)),
  );
  if (result.status === 'committed') browserCookies.delete(token);
  return result;
}

async function source(userId = accountA, claims: Record<string, unknown> = {}, maxAge = 3600) {
  return {
    kind: 'legacy-jwe' as const,
    secret,
    credential: await jwt.encode({
      secret,
      maxAge,
      token: { sub: userId, authSessionId: randomUUID(), gen: 0, ...claims },
    }),
  };
}
async function canonicalSource(options: { readonly lineage?: boolean; readonly authenticatedAt?: Date | null } = {}) {
  const id = randomUUID();
  const token = randomUUID();
  const lineageId = `credential:${randomUUID()}`;
  const expiresAt = new Date(Date.now() + 3_600_000);
  const authenticatedAt = options.authenticatedAt ?? null;
  await environment.database.insert(authSession).values({
    id,
    token,
    userId: accountA,
    expiresAt,
    updatedAt: new Date(),
    legacyLineageId: lineageId,
    revocationGeneration: 0,
    originalAuthenticatedAt: authenticatedAt,
  });
  if (options.lineage !== false)
    await environment.database.insert(authCredentialLineage).values({
      id: lineageId,
      userId: accountA,
      sessionId: id,
      originalAuthenticatedAt: authenticatedAt,
      originalExpiresAt: expiresAt,
    });
  return { credential: { kind: 'canonical-token' as const, token }, id, lineageId, expiresAt, authenticatedAt };
}
async function binding() {
  const created = await createUnpublishedBrowserBinding(
    environment.database,
    qualification,
    new Date(Date.now() + 86_400_000),
  );
  if (created.status !== 'created') throw new Error('Owned binding initialization failed');
  return created;
}
async function intent(
  token: string,
  expectedVersion: number,
  operation: 'login' | 'logout' | 'replacement' = 'login',
  expectedIdentity?: { userId: string; authSessionId: string },
) {
  const prepared = await beginBrowserIntent(environment.database, qualification, token, {
    expectedVersion,
    operation,
    expectedIdentity,
    presented: copyCredential(browserCookies.get(token)),
  });
  if (prepared.status !== 'prepared') throw new Error('Owned intent preparation failed');
  retainedActors.set(prepared.intentToken, copyCredential(browserCookies.get(token)));
  return prepared;
}
function committed(result: BrowserBindingCommitResult) {
  if (result.status !== 'committed') throw new Error('Owned binding commit failed');
  return result;
}
async function login(token: string, version = 0, credential?: FirstPartyCredential) {
  const prepared = await intent(token, version);
  return committed(
    await commitBrowserLogin(
      environment.database,
      qualification,
      token,
      prepared.intentToken,
      credential ?? (await source()),
    ),
  );
}
async function selectAuthority(to: IdentityAuthorityName) {
  await environment.database.transaction(async (transaction) => {
    const [manifest] = await transaction.select().from(authEmailProjection);
    if (manifest.writerAuthority !== to)
      await switchIdentityAuthority(transaction, {
        projectionId: qualification.expectedProjectionId,
        from: manifest.writerAuthority,
        to,
        epoch: manifest.writerEpoch,
      });
  });
}

async function passwordMutation(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  operationId: string,
  kind: 'password-set' | 'password-change' | 'password-reset' = 'password-set',
) {
  const storage = bindIdentityAuthority(transaction, authority);
  const previous = await storage.readPassword(accountA);
  if (previous) {
    if (!(await storage.replacePassword(previous, 'owned-browser-new-password-hash')))
      throw new Error('Owned primary password mutation refused');
  } else await storage.insertPassword(accountA, 'owned-browser-new-password-hash', 0);
  return recordIdentityPasswordMutation(
    transaction,
    {
      expectedProjectionId: authority.projectionId,
      expectedNormalizerVersion: authority.normalizerVersion,
      expectedWriterEpoch: authority.epoch,
      userId: accountA,
      expectedGeneration: 0,
      operationId,
      kind,
      domains: ['first-party', 'partner'],
    },
    authority,
  );
}

async function replacePasswordSelection(
  bindingToken: string,
  intentToken: string,
  candidate: FirstPartyCredential,
  canonicalSessionId?: string,
) {
  const actor = copyCredential(retainedActors.get(intentToken));
  if (!actor) throw new Error('Owned browser actor absent');
  const result = await environment.database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    const authority = await captureIdentityAuthority(transaction, qualification);
    const operationId = randomUUID();
    const preparation = await prepareBrowserReplacementInTransaction(transaction, authority, {
      bindingToken,
      intentToken,
      actor,
      candidate,
      operationId,
      kind: 'password-set',
    });
    const mutation = await passwordMutation(transaction, authority, operationId);
    if (candidate.kind === 'canonical-token' && canonicalSessionId)
      await transaction
        .update(authSession)
        .set({ token: candidate.token, revocationGeneration: 1 })
        .where(eq(authSession.id, canonicalSessionId));
    return commitPreparedBrowserReplacementInTransaction(
      transaction,
      authority,
      preparation,
      mutation.identityGenerationReceipt,
    );
  });
  browserCookies.set(bindingToken, { version: result.cursor.version, credential: { ...candidate } });
  return result;
}

async function expectReplacementRolledBack(bindingToken: string, intentToken: string) {
  expect(await environment.database.select().from(userCredentials)).toEqual([]);
  expect(await environment.database.select().from(authAccount)).toEqual([]);
  expect(await environment.database.select().from(authSubjectCutoffs)).toEqual([]);
  expect(await environment.database.select().from(authSecurityMutationEvents)).toEqual([]);
  expect((await environment.database.select().from(authBrowserBindings))[0].version).toBe(1);
  const [storedIntent] = await environment.database
    .select()
    .from(authBrowserIntents)
    .where(eq(authBrowserIntents.id, createHash('sha256').update(intentToken).digest('hex')));
  expect(storedIntent.consumedAt).toBeNull();
  expect((await readBrowserBinding(environment.database, qualification, bindingToken)).status).toBe('admitted');
}

describe('dark stable browser binding under the selected identity authority', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    await environment.client.unsafe(
      readFileSync(new URL('../../../../../db/drizzle/0312_browser_binding_selection.sql', import.meta.url), 'utf8'),
    );
  });
  beforeEach(async () => {
    browserCookies.clear();
    retainedActors.clear();
    await environment.client.unsafe(
      'TRUNCATE auth_browser_bindings, auth_email_projection, auth_migration_epochs, auth_subject_cutoffs, auth_session_denials, auth_security_mutation_events, auth_credential_lineage, users CASCADE',
    );
    accountA = randomUUID();
    accountB = randomUUID();
    await environment.database.insert(users).values([
      { id: accountA, email: `${accountA}@example.test` },
      { id: accountB, email: `${accountB}@example.test` },
    ]);
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId: qualification.expectedProjectionId });
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => environment?.close());

  for (const authority of ['current-store', 'better-auth'] as const) {
    describe(authority, () => {
      beforeEach(() => selectAuthority(authority));
      it('stores only a digest and preserves unknown age, ancestry and exact credential expiry', async () => {
        const created = await binding();
        const credential = await source(accountA, { legacy_no_sid: true });
        const admitted = await environment.database.transaction((transaction) =>
          sessionReader.readFirstPartySession(transaction, credential, new Date(), (userId) =>
            readLockedWebSubjectState(transaction, userId),
          ),
        );
        expect(admitted.status).toBe('admitted');
        const selected = await login(created.token, 0, credential);
        expect(selected.session).toMatchObject({
          userId: accountA,
          authenticatedAt: null,
          linkGuarded: false,
          requiresAccountCutoff: true,
        });
        if (admitted.status === 'admitted') expect(selected.session).toEqual(admitted.session);
        const [stored] = await environment.database.select().from(authBrowserBindings);
        expect(stored.id).toBe(created.cursor.bindingId);
        expect(JSON.stringify(stored)).not.toContain(created.token);
        expect(await readBrowserBinding(environment.database, qualification, created.token)).toMatchObject({
          status: 'admitted',
          session: selected.session,
        });
      });
      it('lets only the newest login intent commit, even for the same expected version', async () => {
        const created = await binding();
        const earlier = await intent(created.token, 0);
        const later = await intent(created.token, 0);
        expect(
          await commitBrowserLogin(
            environment.database,
            qualification,
            created.token,
            earlier.intentToken,
            await source(),
          ),
        ).toEqual({ status: 'conflict' });
        const selected = committed(
          await commitBrowserLogin(
            environment.database,
            qualification,
            created.token,
            later.intentToken,
            await source(accountB),
          ),
        );
        expect(selected.session?.userId).toBe(accountB);
        expect(selected.cursor.version).toBe(1);
      });
      it.each([false, true])('refuses delayed logout after a newer login, same-user=%s', async (sameUser) => {
        const created = await binding();
        const initial = await login(created.token);
        if (!initial.session) throw new Error('Missing owned session');
        const logout = await intent(created.token, 1, 'logout', initial.session);
        const nextLogin = await intent(created.token, 1);
        const newer = committed(
          await commitBrowserLogin(
            environment.database,
            qualification,
            created.token,
            nextLogin.intentToken,
            await source(sameUser ? accountA : accountB),
          ),
        );
        expect(newer.session?.authSessionId).not.toBe(initial.session.authSessionId);
        expect(
          await commitBrowserLogout(environment.database, qualification, created.token, logout.intentToken),
        ).toEqual({ status: 'conflict' });
        expect(await environment.database.select().from(authSessionDenials)).toEqual([]);
        expect(await readBrowserBinding(environment.database, qualification, created.token)).toMatchObject({
          status: 'admitted',
          session: newer.session,
        });
      });
      it('acknowledges only a current consumed intent and never replays it after a newer intent', async () => {
        const created = await binding();
        const prepared = await intent(created.token, 0);
        const credential = await source();
        const first = committed(
          await commitBrowserLogin(
            environment.database,
            qualification,
            created.token,
            prepared.intentToken,
            credential,
          ),
        );
        expect(
          await commitBrowserLogin(
            environment.database,
            qualification,
            created.token,
            prepared.intentToken,
            credential,
          ),
        ).toMatchObject({ status: 'already-committed', cursor: first.cursor });
        await intent(created.token, 1);
        expect(
          await commitBrowserLogin(
            environment.database,
            qualification,
            created.token,
            prepared.intentToken,
            credential,
          ),
        ).toEqual({ status: 'conflict' });
      });
      it('keeps primary generation denial distinct from anonymous state', async () => {
        const created = await binding();
        const initial = await login(created.token);
        await environment.database.insert(authSubjectCutoffs).values({
          userId: accountA,
          generation: 1,
          revokedThrough: new Date(0),
          lastOperationId: randomUUID(),
        });
        expect(await readBrowserBinding(environment.database, qualification, created.token)).toEqual({
          status: 'denied',
        });
        expect((await environment.database.select().from(authBrowserBindings))[0].version).toBe(initial.cursor.version);
      });
      it('does not acknowledge another credential as a retry of a revoked selection', async () => {
        const created = await binding();
        const prepared = await intent(created.token, 0);
        committed(
          await commitBrowserLogin(
            environment.database,
            qualification,
            created.token,
            prepared.intentToken,
            await source(accountA),
          ),
        );
        await environment.database.insert(authSubjectCutoffs).values({
          userId: accountA,
          generation: 1,
          revokedThrough: new Date(0),
          lastOperationId: randomUUID(),
        });
        expect(
          await commitBrowserLogin(
            environment.database,
            qualification,
            created.token,
            prepared.intentToken,
            await source(accountB),
          ),
        ).toEqual({ status: 'conflict' });
        expect(await readBrowserBinding(environment.database, qualification, created.token)).toEqual({
          status: 'denied',
        });
      });
      it('updates a password replacement only with exact SID, age, ancestry and bounded original expiry', async () => {
        const created = await binding();
        const sid = randomUUID();
        const authTime = Math.floor(Date.now() / 1000) - 30;
        const initial = await login(
          created.token,
          0,
          await source(accountA, { authSessionId: sid, auth_time: authTime, link_guarded: true }),
        );
        if (!initial.session) throw new Error('Missing owned session');
        const prepared = await intent(created.token, 1, 'replacement', initial.session);
        const replacement = await source(
          accountA,
          { authSessionId: sid, gen: 1, auth_time: authTime, link_guarded: true },
          3590,
        );
        const selected = committed(await replacePasswordSelection(created.token, prepared.intentToken, replacement));
        expect(selected.session).toMatchObject({
          authSessionId: sid,
          generation: 1,
          authenticatedAt: initial.session.authenticatedAt,
        });
        expect(selected.session!.expiresAt.getTime()).toBeLessThanOrEqual(initial.session.expiresAt.getTime());
      });
      it('rolls denial, selection and intent consumption back together if the final write fails', async () => {
        const created = await binding();
        const initial = await login(created.token);
        if (!initial.session) throw new Error('Missing owned session');
        const prepared = await intent(created.token, 1, 'logout', initial.session);
        await environment.client.unsafe(
          "CREATE FUNCTION binding_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned receipt fault'; END $$; CREATE TRIGGER binding_reject_receipt BEFORE UPDATE ON auth_browser_intents FOR EACH ROW EXECUTE FUNCTION binding_reject_receipt()",
        );
        try {
          expect(
            await commitBrowserLogout(environment.database, qualification, created.token, prepared.intentToken),
          ).toEqual({ status: 'unavailable' });
          expect(await environment.database.select().from(authSessionDenials)).toEqual([]);
          expect(
            (
              await environment.database
                .select()
                .from(authBrowserIntents)
                .where(eq(authBrowserIntents.expectedVersion, 1))
            )[0].consumedAt,
          ).toBeNull();
          expect(await readBrowserBinding(environment.database, qualification, created.token)).toMatchObject({
            status: 'admitted',
            session: initial.session,
          });
        } finally {
          await environment.client.unsafe(
            'DROP TRIGGER binding_reject_receipt ON auth_browser_intents; DROP FUNCTION binding_reject_receipt()',
          );
        }
        expect(
          await commitBrowserLogout(environment.database, qualification, created.token, prepared.intentToken),
        ).toMatchObject({ status: 'committed', session: null });
        expect(await readBrowserBinding(environment.database, qualification, created.token)).toMatchObject({
          status: 'anonymous',
          cursor: { version: 2 },
        });
      });
    });
  }

  for (const authority of ['current-store', 'better-auth'] as const) {
    describe(`${authority} explicit browser possession`, () => {
      beforeEach(() => selectAuthority(authority));

      it('composes the transaction read seam with actual proof and refuses missing possession', async () => {
        for (const credential of [await source(), (await canonicalSource()).credential]) {
          const created = await binding();
          const selected = await login(created.token, 0, credential);
          await environment.database.transaction(async (transaction) => {
            await transactionSettings(transaction);
            const receipt = await captureIdentityAuthority(transaction, qualification);
            expect(
              await readBrowserBindingInTransaction(transaction, receipt, {
                bindingToken: created.token,
                actor: { version: 1, credential },
              }),
            ).toMatchObject({ status: 'admitted', cursor: selected.cursor, session: selected.session });
            expect(
              await readBrowserBindingInTransaction(transaction, receipt, { bindingToken: created.token }),
            ).toEqual({ status: 'denied' });
          });
        }
      });

      it('throws for a transaction read receipt invalidated by an actual authority switch', async () => {
        const created = await binding();
        const credential = await source();
        await login(created.token, 0, credential);
        const stale = await environment.database.transaction((transaction) =>
          captureIdentityAuthority(transaction, qualification),
        );
        await selectAuthority(authority === 'current-store' ? 'better-auth' : 'current-store');
        await expect(
          environment.database.transaction((transaction) =>
            readBrowserBindingInTransaction(transaction, stale, {
              bindingToken: created.token,
              actor: { version: 1, credential },
            }),
          ),
        ).rejects.toThrow('STALE_AUTHORITY');
        expect(
          (await readBrowserBindingCore(environment.database, qualification, created.token, { version: 1, credential }))
            .status,
        ).toBe('admitted');
      });

      it.each(['legacy-jwe', 'canonical-token'] as const)(
        'never gives a known anonymous token possession of later %s logins',
        async (kind) => {
          const created = await binding();
          expect((await readBrowserBindingCore(environment.database, qualification, created.token)).status).toBe(
            'anonymous',
          );
          const credential = kind === 'legacy-jwe' ? await source() : (await canonicalSource()).credential;
          const initial = await login(created.token, 0, credential);
          expect((await readBrowserBinding(environment.database, qualification, created.token)).status).toBe(
            'admitted',
          );
          expect(await readBrowserBindingCore(environment.database, qualification, created.token)).toEqual({
            status: 'denied',
          });
          const [before] = await environment.database.select().from(authBrowserBindings);
          expect(
            await beginBrowserIntent(environment.database, qualification, created.token, {
              operation: 'login',
              expectedVersion: 1,
            }),
          ).toEqual({ status: 'denied' });
          expect((await environment.database.select().from(authBrowserBindings))[0].intentRevision).toBe(
            before.intentRevision,
          );
          const logout = await intent(created.token, 1, 'logout', initial.session!);
          await commitBrowserLogout(environment.database, qualification, created.token, logout.intentToken);
          const later = await login(created.token, 2, await source(accountB));
          expect(later.session?.userId).toBe(accountB);
          expect(await readBrowserBindingCore(environment.database, qualification, created.token)).toEqual({
            status: 'denied',
          });
          expect(
            await readBrowserBindingCore(environment.database, qualification, created.token, {
              version: 1,
              credential,
            }),
          ).toEqual({ status: 'denied' });
          expect((await readBrowserBinding(environment.database, qualification, created.token)).status).toBe(
            'admitted',
          );
        },
      );

      it('refuses missing, wrong kind/version and renewed actor bytes without consuming a live intent', async () => {
        const created = await binding();
        const sid = randomUUID();
        const credential = await source(accountA, { authSessionId: sid });
        const initial = await login(created.token, 0, credential);
        const prepared = await intent(created.token, 1);
        const retained = retainedActors.get(prepared.intentToken)!;
        const renewed = await source(accountA, { authSessionId: sid });
        expect(renewed.credential).not.toBe(credential.credential);
        const candidate = await source(accountB);
        const wrongActors = [
          undefined,
          { version: 0, credential },
          { version: 1, credential: { kind: 'canonical-token' as const, token: credential.credential } },
          { version: 1, credential: renewed },
          { version: 1, credential: { ...credential, secret: 'different-server-configuration' } },
        ];
        for (const actor of wrongActors) {
          expect(
            await commitBrowserLoginCore(
              environment.database,
              qualification,
              created.token,
              prepared.intentToken,
              candidate,
              actor,
            ),
          ).toEqual({ status: 'conflict' });
          const [stored] = await environment.database
            .select()
            .from(authBrowserIntents)
            .where(eq(authBrowserIntents.id, createHash('sha256').update(prepared.intentToken).digest('hex')));
          expect(stored.consumedAt).toBeNull();
          expect((await environment.database.select().from(authBrowserBindings))[0].version).toBe(
            initial.cursor.version,
          );
        }
        const selected = await commitBrowserLoginCore(
          environment.database,
          qualification,
          created.token,
          prepared.intentToken,
          candidate,
          retained,
        );
        expect(selected).toMatchObject({ status: 'committed', session: { userId: accountB } });
      });

      it('checks current proof before allocating a replacement/logout intent or revealing the selected user', async () => {
        const created = await binding();
        const credential = await source();
        const initial = await login(created.token, 0, credential);
        const canonical = (await canonicalSource()).credential;
        for (const presented of [undefined, { version: 0, credential }, { version: 1, credential: canonical }]) {
          expect(await readBrowserBindingCore(environment.database, qualification, created.token, presented)).toEqual({
            status: 'denied',
          });
          for (const operation of ['login', 'replacement', 'logout'] as const)
            expect(
              await beginBrowserIntent(environment.database, qualification, created.token, {
                expectedVersion: 1,
                operation,
                expectedIdentity: initial.session!,
                presented,
              }),
            ).toEqual({ status: 'denied' });
        }
        expect((await environment.database.select().from(authBrowserBindings))[0].intentRevision).toBe(1);
        expect(await environment.database.select().from(authBrowserIntents)).toHaveLength(1);
      });

      it.each(['logout', 'replacement'] as const)(
        'does not consume %s for missing, wrong-version or different raw actor',
        async (operation) => {
          const created = await binding();
          const sid = randomUUID();
          const credential = await source(accountA, { authSessionId: sid });
          const initial = await login(created.token, 0, credential);
          const prepared = await intent(created.token, 1, operation, initial.session!);
          const candidate = await source(accountA, { authSessionId: sid, gen: 1 }, 3590);
          const actors = [
            undefined,
            { version: 0, credential },
            { version: 1, credential: await source(accountA, { authSessionId: sid }) },
            { version: 1, credential: { ...credential, secret: 'different-server-configuration' } },
          ];
          for (const actor of actors) {
            if (operation === 'logout')
              expect(
                await commitBrowserLogoutCore(
                  environment.database,
                  qualification,
                  created.token,
                  prepared.intentToken,
                  actor,
                ),
              ).toEqual({ status: 'conflict' });
            else
              await expect(
                environment.database.transaction(async (transaction) => {
                  const authorityReceipt = await captureIdentityAuthority(transaction, qualification);
                  return prepareBrowserReplacementInTransaction(transaction, authorityReceipt, {
                    bindingToken: created.token,
                    intentToken: prepared.intentToken,
                    actor: actor as BrowserSelectionCredential,
                    candidate,
                    operationId: randomUUID(),
                    kind: 'password-set',
                  });
                }),
              ).rejects.toThrow('BROWSER_REPLACEMENT_PREPARATION_REFUSED');
            await expectReplacementRolledBack(created.token, prepared.intentToken);
          }
          if (operation === 'logout') {
            expect(
              (await commitBrowserLogout(environment.database, qualification, created.token, prepared.intentToken))
                .status,
            ).toBe('committed');
            expect(
              (await commitBrowserLogoutCore(environment.database, qualification, created.token, prepared.intentToken))
                .status,
            ).toBe('conflict');
            expect(
              (
                await commitBrowserLogoutCore(
                  environment.database,
                  qualification,
                  created.token,
                  prepared.intentToken,
                  retainedActors.get(prepared.intentToken),
                )
              ).status,
            ).toBe('already-committed');
          } else
            expect((await replacePasswordSelection(created.token, prepared.intentToken, candidate)).status).toBe(
              'committed',
            );
        },
      );

      it('acknowledges lost success only for the immutable exact candidate, including canonical token rotation', async () => {
        const created = await binding();
        const proof = await canonicalSource();
        const prepared = await intent(created.token, 0);
        const first = await commitBrowserLogin(
          environment.database,
          qualification,
          created.token,
          prepared.intentToken,
          proof.credential,
        );
        expect(first.status).toBe('committed');
        expect(
          (
            await commitBrowserLoginCore(
              environment.database,
              qualification,
              created.token,
              prepared.intentToken,
              proof.credential,
            )
          ).status,
        ).toBe('already-committed');
        const rotated = { kind: 'canonical-token' as const, token: randomUUID() };
        await environment.database
          .update(authSession)
          .set({ token: rotated.token })
          .where(eq(authSession.id, proof.id));
        expect(
          (
            await readBrowserBindingCore(environment.database, qualification, created.token, {
              version: 1,
              credential: rotated,
            })
          ).status,
        ).toBe('admitted');
        expect(
          await commitBrowserLoginCore(
            environment.database,
            qualification,
            created.token,
            prepared.intentToken,
            rotated,
          ),
        ).toEqual({ status: 'conflict' });
        expect(
          await commitBrowserLoginCore(
            environment.database,
            qualification,
            created.token,
            prepared.intentToken,
            proof.credential,
          ),
        ).toEqual({ status: 'denied' });
      });

      it.each(['unconsumed', 'consumed'] as const)('fails closed for a format1 %s intent', async (state) => {
        const created = await binding();
        const candidate = await source();
        const prepared = await intent(created.token, 0);
        if (state === 'consumed')
          await commitBrowserLogin(environment.database, qualification, created.token, prepared.intentToken, candidate);
        await environment.database.update(authBrowserIntents).set({ formatVersion: 1 });
        expect(
          await commitBrowserLoginCore(
            environment.database,
            qualification,
            created.token,
            prepared.intentToken,
            candidate,
          ),
        ).toEqual({ status: 'conflict' });
        expect((await environment.database.select().from(authBrowserBindings))[0].version).toBe(
          state === 'consumed' ? 1 : 0,
        );
      });

      it.each([
        { kind: 'legacy-jwe', knownAge: true },
        { kind: 'legacy-jwe', knownAge: false },
        { kind: 'canonical-token', knownAge: true },
        { kind: 'canonical-token', knownAge: false },
      ] as const)(
        'commits a real same-transaction password mutation with original $kind possession, known-age=$knownAge and exact retry',
        async ({ kind, knownAge }) => {
          const created = await binding();
          const authenticatedAt = knownAge ? new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000) : null;
          const canonical = kind === 'canonical-token' ? await canonicalSource({ authenticatedAt }) : undefined;
          const sid = canonical?.id ?? randomUUID();
          const actorCredential =
            canonical?.credential ??
            (await source(accountA, {
              authSessionId: sid,
              ...(authenticatedAt
                ? { auth_time: Math.floor(authenticatedAt.getTime() / 1000), link_guarded: true }
                : {}),
            }));
          const initial = await login(created.token, 0, actorCredential);
          const prepared = await intent(created.token, 1, 'replacement', initial.session!);
          const actor = retainedActors.get(prepared.intentToken)!;
          const candidate = canonical
            ? { kind: 'canonical-token' as const, token: randomUUID() }
            : await source(
                accountA,
                {
                  authSessionId: sid,
                  gen: 1,
                  ...(authenticatedAt
                    ? { auth_time: Math.floor(authenticatedAt.getTime() / 1000), link_guarded: true }
                    : {}),
                },
                3590,
              );
          expect(
            await commitBrowserLoginCore(
              environment.database,
              qualification,
              created.token,
              prepared.intentToken,
              candidate,
              actor,
            ),
          ).toEqual({ status: 'denied' });
          const result = await replacePasswordSelection(created.token, prepared.intentToken, candidate, canonical?.id);
          expect(result).toMatchObject({
            status: 'committed',
            cursor: { version: 2 },
            session: {
              userId: accountA,
              authSessionId: sid,
              generation: 1,
              authenticatedAt,
              linkGuarded: initial.session?.linkGuarded,
              requiresAccountCutoff: initial.session?.requiresAccountCutoff,
            },
          });
          expect(result.session!.expiresAt.getTime()).toBeLessThanOrEqual(initial.session!.expiresAt.getTime());
          const [cutoff] = await environment.database.select().from(authSubjectCutoffs);
          const [event] = await environment.database.select().from(authSecurityMutationEvents);
          expect(cutoff.generation).toBe(1);
          expect(event).toMatchObject({ kind: 'password-set', previousGeneration: 0, generation: 1 });
          const persistedIntents = JSON.stringify(await environment.database.select().from(authBrowserIntents));
          expect(persistedIntents).not.toContain(secret);
          expect(persistedIntents).not.toContain(
            candidate.kind === 'canonical-token' ? candidate.token : candidate.credential,
          );
          expect(persistedIntents).not.toContain(
            actorCredential.kind === 'canonical-token' ? actorCredential.token : actorCredential.credential,
          );
          expect((await environment.database.select().from(userCredentials))[0].passwordHash).toBe(
            'owned-browser-new-password-hash',
          );
          if (authority === 'better-auth')
            expect((await environment.database.select().from(authAccount))[0]).toMatchObject({
              password: 'owned-browser-new-password-hash',
              sourceGeneration: 1,
            });
          expect(
            await commitBrowserLoginCore(
              environment.database,
              qualification,
              created.token,
              prepared.intentToken,
              candidate,
              actor,
            ),
          ).toMatchObject({ status: 'already-committed', cursor: { version: 2 } });
          expect(
            await commitBrowserLoginCore(
              environment.database,
              qualification,
              created.token,
              prepared.intentToken,
              candidate,
            ),
          ).toEqual({ status: 'conflict' });
          expect(
            await commitBrowserLoginCore(
              environment.database,
              qualification,
              created.token,
              prepared.intentToken,
              actorCredential,
              actor,
            ),
          ).toEqual({ status: 'denied' });
        },
      );

      it.each([
        'forged preparation',
        'copied preparation',
        'forged mutation',
        'other operation',
        'other kind',
        'reset receipt',
        'other user',
      ] as const)('rolls the actual password write back for %s', async (misuse) => {
        const created = await binding();
        const sid = randomUUID();
        const initial = await login(created.token, 0, await source(accountA, { authSessionId: sid }));
        const prepared = await intent(created.token, 1, 'replacement', initial.session!);
        const candidate = await source(accountA, { authSessionId: sid, gen: 1 }, 3590);
        await expect(
          environment.database.transaction(async (transaction) => {
            await transactionSettings(transaction);
            const authorityReceipt = await captureIdentityAuthority(transaction, qualification);
            const operationId = randomUUID();
            const preparation = await prepareBrowserReplacementInTransaction(transaction, authorityReceipt, {
              bindingToken: created.token,
              intentToken: prepared.intentToken,
              actor: retainedActors.get(prepared.intentToken)!,
              candidate,
              operationId,
              kind: 'password-set',
            });
            const mutation = await passwordMutation(
              transaction,
              authorityReceipt,
              misuse === 'other operation' ? randomUUID() : operationId,
              misuse === 'other kind'
                ? 'password-change'
                : misuse === 'reset receipt'
                  ? 'password-reset'
                  : 'password-set',
            );
            let receipt = mutation.identityGenerationReceipt;
            if (misuse === 'other user') {
              const other = await recordCheckedSecurityMutation(transaction, {
                expectedProjectionId: authorityReceipt.projectionId,
                expectedNormalizerVersion: authorityReceipt.normalizerVersion,
                expectedWriterEpoch: authorityReceipt.epoch,
                operationId: randomUUID(),
                userId: accountB,
                expectedGeneration: 0,
                kind: 'password-set',
                domains: ['first-party', 'partner'],
              });
              receipt = other.identityGenerationReceipt;
            }
            return commitPreparedBrowserReplacementInTransaction(
              transaction,
              authorityReceipt,
              misuse === 'forged preparation'
                ? ({} as BrowserReplacementPreparation)
                : misuse === 'copied preparation'
                  ? { ...preparation }
                  : preparation,
              misuse === 'forged mutation' ? ({} as IdentityGenerationMutationReceipt) : receipt,
            );
          }),
        ).rejects.toThrow(
          /BROWSER_REPLACEMENT_PREPARATION_INVALID|AUTH_IDENTITY_(?:CONTINUATION|MUTATION)_RECEIPT_INVALID/,
        );
        await expectReplacementRolledBack(created.token, prepared.intentToken);
      });

      it.each(['preparation', 'mutation receipt'] as const)(
        'rejects a %s from another physical transaction and rolls back the local mutation',
        async (foreign) => {
          const created = await binding();
          const sid = randomUUID();
          const initial = await login(created.token, 0, await source(accountA, { authSessionId: sid }));
          const pending = await intent(created.token, 1, 'replacement', initial.session!);
          const actor = retainedActors.get(pending.intentToken)!;
          const candidate = await source(accountA, { authSessionId: sid, gen: 1 }, 3590);
          const operationId = randomUUID();
          let foreignPreparation: BrowserReplacementPreparation | undefined;
          let foreignMutation: IdentityGenerationMutationReceipt | undefined;
          const rollback = new Error('Owned foreign transaction rollback');
          await expect(
            environment.database.transaction(async (transaction) => {
              await transactionSettings(transaction);
              const authorityReceipt = await captureIdentityAuthority(transaction, qualification);
              foreignPreparation = await prepareBrowserReplacementInTransaction(transaction, authorityReceipt, {
                bindingToken: created.token,
                intentToken: pending.intentToken,
                actor,
                candidate,
                operationId,
                kind: 'password-set',
              });
              foreignMutation = (await passwordMutation(transaction, authorityReceipt, operationId))
                .identityGenerationReceipt;
              throw rollback;
            }),
          ).rejects.toBe(rollback);
          await expect(
            environment.database.transaction(async (transaction) => {
              await transactionSettings(transaction);
              const authorityReceipt = await captureIdentityAuthority(transaction, qualification);
              const localPreparation = await prepareBrowserReplacementInTransaction(transaction, authorityReceipt, {
                bindingToken: created.token,
                intentToken: pending.intentToken,
                actor,
                candidate,
                operationId,
                kind: 'password-set',
              });
              const mutation = await passwordMutation(transaction, authorityReceipt, operationId);
              return commitPreparedBrowserReplacementInTransaction(
                transaction,
                authorityReceipt,
                foreign === 'preparation' ? foreignPreparation! : localPreparation,
                foreign === 'mutation receipt' ? foreignMutation! : mutation.identityGenerationReceipt,
              );
            }),
          ).rejects.toThrow(
            foreign === 'preparation'
              ? 'BROWSER_REPLACEMENT_PREPARATION_INVALID'
              : 'AUTH_IDENTITY_MUTATION_RECEIPT_INVALID',
          );
          await expectReplacementRolledBack(created.token, pending.intentToken);
        },
      );

      it.each(['password-reset', 'admin-revocation', 'account-deletion', 'legacy-signout'] as const)(
        'never prepares requesting-device preservation for %s',
        async (kind) => {
          const created = await binding();
          const initial = await login(created.token);
          const pending = await intent(created.token, 1, 'replacement', initial.session!);
          await expect(
            environment.database.transaction(async (transaction) => {
              const authorityReceipt = await captureIdentityAuthority(transaction, qualification);
              return prepareBrowserReplacementInTransaction(transaction, authorityReceipt, {
                bindingToken: created.token,
                intentToken: pending.intentToken,
                actor: retainedActors.get(pending.intentToken)!,
                candidate: await source(),
                operationId: randomUUID(),
                kind: kind as 'password-set',
              });
            }),
          ).rejects.toThrow('BROWSER_REPLACEMENT_PREPARATION_REFUSED');
          await expectReplacementRolledBack(created.token, pending.intentToken);
        },
      );

      it.each(['SID', 'age', 'ancestry', 'expiry'] as const)(
        'rolls credential/cutoff/event writes back if the candidate changes original %s',
        async (changed) => {
          const created = await binding();
          const sid = randomUUID();
          const authenticatedAt = Math.floor(Date.now() / 1000) - 60;
          const initial = await login(
            created.token,
            0,
            await source(accountA, { authSessionId: sid, auth_time: authenticatedAt, link_guarded: true }),
          );
          const pending = await intent(created.token, 1, 'replacement', initial.session!);
          const candidate = await source(
            accountA,
            {
              authSessionId: changed === 'SID' ? randomUUID() : sid,
              gen: 1,
              auth_time: changed === 'age' ? authenticatedAt + 30 : authenticatedAt,
              link_guarded: true,
              ...(changed === 'ancestry' ? { legacy_no_sid: true } : {}),
            },
            changed === 'expiry' ? 7200 : 3590,
          );
          await expect(replacePasswordSelection(created.token, pending.intentToken, candidate)).rejects.toThrow(
            'BROWSER_REPLACEMENT_CANDIDATE_MISMATCH',
          );
          await expectReplacementRolledBack(created.token, pending.intentToken);
        },
      );

      it('rolls primary password, mirror, cutoff, event, selection and intent back after an actual final receipt write fails', async () => {
        const created = await binding();
        const sid = randomUUID();
        const initial = await login(created.token, 0, await source(accountA, { authSessionId: sid }));
        const pending = await intent(created.token, 1, 'replacement', initial.session!);
        const candidate = await source(accountA, { authSessionId: sid, gen: 1 }, 3590);
        await environment.client.unsafe(
          "CREATE FUNCTION replacement_reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned final replacement fault'; END $$; CREATE TRIGGER replacement_reject_receipt BEFORE UPDATE ON auth_browser_intents FOR EACH ROW EXECUTE FUNCTION replacement_reject_receipt()",
        );
        try {
          await expect(replacePasswordSelection(created.token, pending.intentToken, candidate)).rejects.toMatchObject({
            cause: { message: 'owned final replacement fault' },
          });
          await expectReplacementRolledBack(created.token, pending.intentToken);
        } finally {
          await environment.client.unsafe(
            'DROP TRIGGER replacement_reject_receipt ON auth_browser_intents; DROP FUNCTION replacement_reject_receipt()',
          );
        }
        expect((await replacePasswordSelection(created.token, pending.intentToken, candidate)).status).toBe(
          'committed',
        );
      });

      it('snapshots the operation request before waiting on authority revalidation', async () => {
        const created = await binding();
        const sid = randomUUID();
        const initial = await login(created.token, 0, await source(accountA, { authSessionId: sid }));
        const pending = await intent(created.token, 1, 'replacement', initial.session!);
        const candidate = await source(accountA, { authSessionId: sid, gen: 1 }, 3590);
        const operationId = randomUUID();
        const request = {
          bindingToken: created.token,
          intentToken: pending.intentToken,
          actor: retainedActors.get(pending.intentToken)!,
          candidate,
          operationId,
          kind: 'password-set' as const,
        };
        let release = () => {};
        let entered = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const ready = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const original = authorityRouter.revalidateIdentityAuthority;
        const paused = vi
          .spyOn(authorityRouter, 'revalidateIdentityAuthority')
          .mockImplementationOnce(async (...parameters) => {
            entered();
            await held;
            return original(...parameters);
          });
        const result = environment.database.transaction(async (transaction) => {
          await transactionSettings(transaction);
          const authorityReceipt = await captureIdentityAuthority(transaction, qualification);
          const preparation = await prepareBrowserReplacementInTransaction(transaction, authorityReceipt, request);
          const mutation = await passwordMutation(transaction, authorityReceipt, operationId);
          return commitPreparedBrowserReplacementInTransaction(
            transaction,
            authorityReceipt,
            preparation,
            mutation.identityGenerationReceipt,
          );
        });
        try {
          await ready;
          request.operationId = randomUUID();
          request.bindingToken = 'not-a-binding';
          release();
          expect((await result).status).toBe('committed');
        } finally {
          release();
          paused.mockRestore();
        }
      });

      it('rolls logout denial and selection back when the final receipt write waits past its actual database deadline', async () => {
        const created = await binding();
        const initial = await login(created.token);
        const pending = await intent(created.token, 1, 'logout', initial.session!);
        const address = new URL(
          process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
        );
        address.pathname = `/${environment.client.options.database}`;
        const observer = postgres(address.toString(), { max: 2, onnotice: () => {} });
        const lockKey = 69750312;
        let release = () => {};
        let ready = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const acquired = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const blocker = observer.begin(async (transaction) => {
          await transaction`SELECT pg_advisory_xact_lock(${lockKey})`;
          ready();
          await held;
        });
        await acquired;
        await environment.client.unsafe(
          `CREATE FUNCTION binding_hold_final_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(${lockKey}); RETURN NEW; END $$; CREATE TRIGGER binding_hold_final_receipt BEFORE UPDATE OF consumed_at ON auth_browser_intents FOR EACH ROW EXECUTE FUNCTION binding_hold_final_receipt()`,
        );
        let settled = false;
        let completion: Promise<BrowserBindingCommitResult> | undefined;
        try {
          const [deadline] = await observer<{ expires_at: Date }[]>`
            UPDATE auth_browser_intents SET expires_at=clock_timestamp()+interval '1200 milliseconds'
            WHERE id=${createHash('sha256').update(pending.intentToken).digest('hex')}
            RETURNING expires_at
          `;
          const started = Date.now();
          completion = commitBrowserLogout(
            environment.database,
            qualification,
            created.token,
            pending.intentToken,
          ).then((result) => {
            settled = true;
            return result;
          });
          let observed = false;
          while (Date.now() - started < 2500) {
            const [state] = await observer<{ waiting: boolean; expired: boolean }[]>`
              SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
                AND wait_event_type='Lock' AND wait_event='advisory'
                AND query ILIKE '%auth_browser_intents%' AND query ILIKE 'update%') AS waiting,
                clock_timestamp() >= ${deadline.expires_at} AS expired
            `;
            if (state.waiting) observed = true;
            if (state.expired) {
              expect(state.waiting).toBe(true);
              break;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
          expect(observed).toBe(true);
          const [expired] = await observer<
            { expired: boolean }[]
          >`SELECT clock_timestamp() >= ${deadline.expires_at} AS expired`;
          expect(expired.expired).toBe(true);
          // A statement/lock timeout would have settled before release. The
          // actual held query is still live, well inside its four-second budget.
          expect(settled).toBe(false);
          expect(Date.now() - started).toBeLessThan(3000);
          release();
          await blocker;
          expect(await completion).toEqual({ status: 'unavailable' });
          await expectReplacementRolledBack(created.token, pending.intentToken);
          expect(await environment.database.select().from(authSessionDenials)).toEqual([]);
        } finally {
          release();
          await blocker;
          await completion;
          await environment.client.unsafe(
            'DROP TRIGGER binding_hold_final_receipt ON auth_browser_intents; DROP FUNCTION binding_hold_final_receipt()',
          );
          await observer.end();
        }
      });
    });
  }

  for (const authority of ['current-store', 'better-auth'] as const) {
    describe(`${authority} canonical source lifecycle`, () => {
      beforeEach(() => selectAuthority(authority));
      it.each([false, true])('retains conservative ancestry with optional lineage present=%s', async (lineage) => {
        const created = await binding();
        const proof = await canonicalSource({ lineage });
        const initial = await login(created.token, 0, proof.credential);
        expect(initial.session).toMatchObject({
          userId: accountA,
          authSessionId: proof.id,
          requiresAccountCutoff: true,
          authenticatedAt: null,
          linkGuarded: false,
          expiresAt: proof.expiresAt,
        });
        const [stored] = await environment.database.select().from(authBrowserBindings);
        expect(stored.credentialKind).toBe('canonical-token');
        expect(JSON.stringify(stored)).not.toContain(proof.credential.token);
        expect(await readBrowserBinding(environment.database, qualification, created.token)).toMatchObject({
          status: 'admitted',
          session: initial.session,
        });
      });
      it.each(['row removal', 'shortened expiry', 'lineage revocation'] as const)(
        'refuses canonical %s on reads and consumed retries',
        async (mutation) => {
          const created = await binding();
          const proof = await canonicalSource();
          const prepared = await intent(created.token, 0);
          committed(
            await commitBrowserLogin(
              environment.database,
              qualification,
              created.token,
              prepared.intentToken,
              proof.credential,
            ),
          );
          if (mutation === 'row removal')
            await environment.database.delete(authSession).where(eq(authSession.id, proof.id));
          else if (mutation === 'shortened expiry')
            await environment.database
              .update(authSession)
              .set({ expiresAt: new Date(0) })
              .where(eq(authSession.id, proof.id));
          else
            await environment.database
              .update(authCredentialLineage)
              .set({ revokedAt: new Date() })
              .where(eq(authCredentialLineage.id, proof.lineageId));
          expect(await readBrowserBinding(environment.database, qualification, created.token)).toEqual({
            status: 'denied',
          });
          expect(
            await commitBrowserLogin(
              environment.database,
              qualification,
              created.token,
              prepared.intentToken,
              proof.credential,
            ),
          ).toEqual({ status: 'denied' });
          const [stored] = await environment.database.select().from(authBrowserBindings);
          expect(stored).toMatchObject({ version: 1, userId: accountA, authSessionId: proof.id });
          expect(await environment.database.select().from(authSessionDenials)).toEqual([]);
        },
      );
      it('caps renewal at original expiry and honors a shorter live deadline without freshening age', async () => {
        const created = await binding();
        const authenticatedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 30_000);
        const proof = await canonicalSource({ authenticatedAt });
        const prepared = await intent(created.token, 0);
        const initial = committed(
          await commitBrowserLogin(
            environment.database,
            qualification,
            created.token,
            prepared.intentToken,
            proof.credential,
          ),
        );
        await environment.database
          .update(authSession)
          .set({ expiresAt: new Date(proof.expiresAt.getTime() + 3_600_000) })
          .where(eq(authSession.id, proof.id));
        expect(await readBrowserBinding(environment.database, qualification, created.token)).toMatchObject({
          status: 'admitted',
          session: initial.session,
        });
        expect(
          await commitBrowserLogin(
            environment.database,
            qualification,
            created.token,
            prepared.intentToken,
            proof.credential,
          ),
        ).toMatchObject({ status: 'already-committed', session: initial.session });
        const shortened = new Date(Date.now() + 300_000);
        await environment.database
          .update(authSession)
          .set({ expiresAt: shortened })
          .where(eq(authSession.id, proof.id));
        const expected = { ...initial.session, authenticatedAt, expiresAt: shortened };
        expect(await readBrowserBinding(environment.database, qualification, created.token)).toMatchObject({
          status: 'admitted',
          session: expected,
        });
        expect(
          await commitBrowserLogin(
            environment.database,
            qualification,
            created.token,
            prepared.intentToken,
            proof.credential,
          ),
        ).toMatchObject({ status: 'already-committed', session: expected });
      });
      it.each(['age', 'ancestry'] as const)(
        'refuses canonical %s drift rather than manufacturing new proof',
        async (mutation) => {
          const created = await binding();
          const proof = await canonicalSource();
          await login(created.token, 0, proof.credential);
          await environment.database
            .update(authSession)
            .set(mutation === 'age' ? { originalAuthenticatedAt: new Date() } : { legacyLineageId: null })
            .where(eq(authSession.id, proof.id));
          expect(await readBrowserBinding(environment.database, qualification, created.token)).toEqual({
            status: 'denied',
          });
        },
      );
      it.each(['row removal', 'shortened expiry', 'lineage revocation'] as const)(
        'clears refused canonical %s without revoking a later same-generation login',
        async (mutation) => {
          const created = await binding();
          const old = await canonicalSource();
          const selected = await login(created.token, 0, old.credential);
          if (!selected.session) throw new Error('Owned selection absent');
          const logout = await intent(created.token, 1, 'logout', selected.session);
          if (mutation === 'row removal')
            await environment.database.delete(authSession).where(eq(authSession.id, old.id));
          else if (mutation === 'shortened expiry')
            await environment.database
              .update(authSession)
              .set({ expiresAt: new Date(0) })
              .where(eq(authSession.id, old.id));
          else
            await environment.database
              .update(authCredentialLineage)
              .set({ revokedAt: new Date() })
              .where(eq(authCredentialLineage.id, old.lineageId));
          expect(await readBrowserBinding(environment.database, qualification, created.token)).toEqual({
            status: 'denied',
          });
          const later = await canonicalSource();
          const readLater = () =>
            environment.database.transaction((transaction) =>
              sessionReader.readFirstPartySession(transaction, later.credential, new Date(), (userId) =>
                readLockedWebSubjectState(transaction, userId),
              ),
            );
          expect((await readLater()).status).toBe('admitted');
          expect(
            await commitBrowserLogout(environment.database, qualification, created.token, logout.intentToken),
          ).toMatchObject({ status: 'committed', session: null, cursor: { version: 2 } });
          expect(await readBrowserBinding(environment.database, qualification, created.token)).toMatchObject({
            status: 'anonymous',
          });
          expect((await readLater()).status).toBe('admitted');
          expect(await environment.database.select().from(authSubjectCutoffs)).toEqual([]);
          expect(await environment.database.select().from(authSessionDenials)).toEqual([]);
          expect(await environment.database.select().from(authSecurityMutationEvents)).toEqual([]);
        },
      );
      it('does not acknowledge or consume logout when canonical admission is unavailable', async () => {
        const created = await binding();
        const proof = await canonicalSource();
        const selected = await login(created.token, 0, proof.credential);
        if (!selected.session) throw new Error('Owned selection absent');
        const logout = await intent(created.token, 1, 'logout', selected.session);
        const unavailable = vi
          .spyOn(sessionReader, 'readFirstPartySession')
          .mockResolvedValueOnce({ status: 'unavailable' });
        expect(
          await commitBrowserLogout(environment.database, qualification, created.token, logout.intentToken),
        ).toEqual({ status: 'unavailable' });
        expect((await environment.database.select().from(authBrowserBindings))[0].version).toBe(1);
        const [storedIntent] = await environment.database
          .select()
          .from(authBrowserIntents)
          .where(eq(authBrowserIntents.id, createHash('sha256').update(logout.intentToken).digest('hex')));
        expect(storedIntent.consumedAt).toBeNull();
        expect(await environment.database.select().from(authSubjectCutoffs)).toEqual([]);
        expect(await environment.database.select().from(authSecurityMutationEvents)).toEqual([]);
        unavailable.mockRestore();
        expect(
          await commitBrowserLogout(environment.database, qualification, created.token, logout.intentToken),
        ).toMatchObject({ status: 'committed', session: null });
      });
      it('refuses canonical-to-JWE replacement downgrade and allows the canonical generation continuation', async () => {
        const created = await binding();
        const proof = await canonicalSource();
        const selected = await login(created.token, 0, proof.credential);
        if (!selected.session) throw new Error('Owned selection absent');
        const replacement = await intent(created.token, 1, 'replacement', selected.session);
        const downgraded = await source(accountA, { authSessionId: proof.id, gen: 1, legacy_no_sid: true }, 1800);
        await expect(replacePasswordSelection(created.token, replacement.intentToken, downgraded)).rejects.toThrow(
          'BROWSER_REPLACEMENT_PREPARATION_REFUSED',
        );
        expect((await environment.database.select().from(authBrowserBindings))[0]).toMatchObject({
          version: 1,
          credentialKind: 'canonical-token',
        });
        const candidate = { kind: 'canonical-token' as const, token: randomUUID() };
        const current = committed(
          await replacePasswordSelection(created.token, replacement.intentToken, candidate, proof.id),
        );
        expect(current).toMatchObject({
          cursor: { version: 2 },
          session: { generation: 1, authSessionId: proof.id, expiresAt: proof.expiresAt },
        });
        expect((await environment.database.select().from(authBrowserBindings))[0].credentialKind).toBe(
          'canonical-token',
        );
        await environment.database.delete(authSession).where(eq(authSession.id, proof.id));
        expect(await readBrowserBinding(environment.database, qualification, created.token)).toEqual({
          status: 'denied',
        });
      });
      it.each(['row removal', 'shortened expiry', 'lineage revocation'] as const)(
        'rechecks canonical %s after an observed binding lock wait',
        async (mutation) => {
          const created = await binding();
          const proof = await canonicalSource();
          const prepared = await intent(created.token, 0);
          const address = new URL(
            process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
          );
          address.pathname = `/${environment.client.options.database}`;
          const unfenced = postgres(address.toString(), { max: 1, onnotice: () => {} });
          let release = () => {};
          let locked = () => {};
          let admitted = () => {};
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          const lockReady = new Promise<void>((resolve) => {
            locked = resolve;
          });
          const admissionReady = new Promise<void>((resolve) => {
            admitted = resolve;
          });
          const original = sessionReader.readFirstPartySession;
          vi.spyOn(sessionReader, 'readFirstPartySession').mockImplementation(async (...parameters) => {
            const result = await original(...parameters);
            if (result.status === 'admitted') admitted();
            return result;
          });
          const blocker = environment.database.transaction(async (transaction) => {
            await transaction
              .select()
              .from(authBrowserBindings)
              .where(eq(authBrowserBindings.id, created.cursor.bindingId))
              .for('update');
            locked();
            await held;
          });
          await lockReady;
          const pending = commitBrowserLogin(
            environment.database,
            qualification,
            created.token,
            prepared.intentToken,
            proof.credential,
          );
          try {
            await admissionReady;
            let observed = false;
            for (let attempt = 0; attempt < 100; attempt++) {
              const [state] = await unfenced<
                { waiting: boolean }[]
              >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%auth_browser_bindings%' AND query ILIKE '%for update%') AS waiting`;
              if (state.waiting) {
                observed = true;
                break;
              }
              await new Promise<void>((resolve) => setTimeout(resolve, 10));
            }
            expect(observed).toBe(true);
            if (mutation === 'row removal') await unfenced`DELETE FROM public.auth_session WHERE id=${proof.id}`;
            else if (mutation === 'shortened expiry')
              await unfenced`UPDATE public.auth_session SET expires_at=TIMESTAMP '1970-01-01' WHERE id=${proof.id}`;
            else
              await unfenced`UPDATE public.auth_credential_lineage SET revoked_at=clock_timestamp() WHERE id=${proof.lineageId}`;
          } finally {
            release();
            await blocker;
            await unfenced.end();
          }
          expect(await pending).toEqual({ status: 'denied' });
          expect((await environment.database.select().from(authBrowserBindings))[0].version).toBe(0);
          expect((await environment.database.select().from(authBrowserIntents))[0].consumedAt).toBeNull();
        },
      );
    });
  }

  it('invalidates a pending intent across an actual selected-authority switch', async () => {
    const created = await binding();
    const prepared = await intent(created.token, 0);
    await selectAuthority('better-auth');
    expect(
      await commitBrowserLogin(
        environment.database,
        qualification,
        created.token,
        prepared.intentToken,
        await source(),
      ),
    ).toEqual({ status: 'conflict' });
    expect((await environment.database.select().from(authBrowserBindings))[0].version).toBe(0);
    expect((await login(created.token)).session?.userId).toBe(accountA);
  });
  it('rolls all writes back if authority proof drifts inside the transaction', async () => {
    const created = await binding();
    const prepared = await intent(created.token, 0);
    await environment.client.unsafe(
      'CREATE FUNCTION binding_drift_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE auth_email_projection SET writer_epoch=writer_epoch+1; RETURN NEW; END $$; CREATE TRIGGER binding_drift_receipt AFTER UPDATE OF version ON auth_browser_bindings FOR EACH ROW EXECUTE FUNCTION binding_drift_receipt()',
    );
    try {
      expect(
        await commitBrowserLogin(
          environment.database,
          qualification,
          created.token,
          prepared.intentToken,
          await source(),
        ),
      ).toEqual({ status: 'unavailable' });
      expect((await environment.database.select().from(authBrowserBindings))[0].version).toBe(0);
      expect((await environment.database.select().from(authBrowserIntents))[0].consumedAt).toBeNull();
      expect((await environment.database.select().from(authEmailProjection))[0].writerEpoch).toBe(1);
    } finally {
      await environment.client.unsafe(
        'DROP TRIGGER binding_drift_receipt ON auth_browser_bindings; DROP FUNCTION binding_drift_receipt()',
      );
    }
  });
  it('refuses an intent from a different binding and expires pending intent evidence', async () => {
    const first = await binding();
    const second = await binding();
    const prepared = await intent(first.token, 0);
    expect(
      await commitBrowserLogin(environment.database, qualification, second.token, prepared.intentToken, await source()),
    ).toEqual({ status: 'conflict' });
    await environment.database
      .update(authBrowserIntents)
      .set({ createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1000) });
    expect(
      await commitBrowserLogin(environment.database, qualification, first.token, prepared.intentToken, await source()),
    ).toEqual({ status: 'conflict' });
    expect((await environment.database.select().from(authBrowserBindings)).every((row) => row.version === 0)).toBe(
      true,
    );
  });
  it('rechecks the credential deadline after waiting for its binding lock', async () => {
    const created = await binding();
    const prepared = await intent(created.token, 0);
    const credential = await source(accountA, {}, 1);
    let release = () => {};
    let verified = () => {};
    let locked = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const admitted = new Promise<void>((resolve) => {
      verified = resolve;
    });
    const original = sessionReader.readFirstPartySession;
    vi.spyOn(sessionReader, 'readFirstPartySession').mockImplementation(async (...parameters) => {
      const result = await original(...parameters);
      verified();
      return result;
    });
    const owner = environment.database.transaction(async (transaction) => {
      await transaction
        .select()
        .from(authBrowserBindings)
        .where(eq(authBrowserBindings.id, created.cursor.bindingId))
        .for('update');
      locked();
      await held;
    });
    await ready;
    const pending = commitBrowserLogin(
      environment.database,
      qualification,
      created.token,
      prepared.intentToken,
      credential,
    );
    try {
      await admitted;
      await new Promise<void>((resolve) => setTimeout(resolve, 1100));
    } finally {
      release();
      await owner;
    }
    expect(await pending).toEqual({ status: 'conflict' });
    expect((await environment.database.select().from(authBrowserBindings))[0].version).toBe(0);
  });
  it('keeps the binding cookie identical across selections and refuses ambiguous presented names', async () => {
    const created = await binding();
    const before = serializeBrowserBindingCookie(
      created.token,
      created.cursor,
      'https://www.boardsesh.test',
      '.boardsesh.test',
    );
    const selected = await login(created.token);
    expect(
      serializeBrowserBindingCookie(created.token, selected.cursor, 'https://www.boardsesh.test', '.boardsesh.test'),
    ).toBe(before);
    expect(before).toContain('HttpOnly; Secure; SameSite=Lax; Domain=.boardsesh.test');
    expect(presentedBrowserBinding(`${BROWSER_BINDING_COOKIE}=${created.token}`)).toEqual({
      status: 'present',
      token: created.token,
    });
    expect(
      presentedBrowserBinding(`${BROWSER_BINDING_COOKIE}=${created.token}; ${BROWSER_BINDING_COOKIE}=${created.token}`),
    ).toEqual({ status: 'invalid' });
    expect(presentedBrowserBinding(`${BROWSER_BINDING_COOKIE}.0=${created.token}`)).toEqual({ status: 'invalid' });
    expect(() =>
      serializeBrowserBindingCookie(created.token, created.cursor, 'https://evil.example', '.boardsesh.test'),
    ).toThrow('BROWSER_BINDING_COOKIE_SCOPE_INVALID');
    expect(BROWSER_BINDING_PUBLIC_BOOTSTRAP_READY).toBe(false);
    expect(assertBrowserBindingPublicBootstrap).toThrow('BROWSER_BINDING_COORDINATOR_UNQUALIFIED');
  });
});
