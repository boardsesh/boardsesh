import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  authBrowserBindings,
  authBrowserRenewals,
  authCredentialLineage,
  authEmailProjection,
  authSession,
  authSessionDenials,
  authSubjectCutoffs,
  users,
} from '@boardsesh/db/schema/auth';
import type { BrowserRenewalCommand, BrowserRenewalReply } from '@boardsesh/auth-protocol/browser-renewal-v1';
import { createEnvironment } from './environment';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import {
  beginBrowserIntent,
  commitBrowserLogin,
  createUnpublishedBrowserBinding,
  readBrowserBinding,
  type BrowserSelectionCredential,
} from '../browser-binding';
import { switchIdentityAuthority } from '../router';
import { executeBrowserRenewalCommand } from '../browser-renewal';
import { readFirstPartySession } from '../session-reader';
import { readLockedWebSubjectState } from '../../current-store/web-credential-state';
import { providerDatabaseNow } from '../provider-security-context';
import * as authorityRouter from '../router';

const requireWeb = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = requireWeb('next-auth/jwt') as {
  encode(input: { secret: string; token: Record<string, unknown>; maxAge: number }): Promise<string>;
  decode(input: { secret: string; token: string }): Promise<Record<string, unknown> | null>;
};
const secret = 'owned-browser-renewal-fixture-secret';
const qualification = {
  expectedProjectionId: randomUUID(),
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
};
const runtime = { qualification, legacySecret: secret };
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let ownerId: string;
const nonceHash = 'e'.repeat(64);
function command<Operation extends BrowserRenewalCommand['operation']>(
  operation: Operation,
  payload: Extract<BrowserRenewalCommand, { operation: Operation }>['payload'],
): BrowserRenewalCommand {
  return {
    browserRenewalProtocolVersion: 1,
    requestId: randomUUID(),
    issuedAt: Date.now(),
    operation,
    payload,
  } as BrowserRenewalCommand;
}
async function invoke(commandInput: BrowserRenewalCommand) {
  return executeBrowserRenewalCommand(environment.database, runtime, commandInput);
}
function prepared(reply: BrowserRenewalReply) {
  if (reply.outcome !== 'prepared') throw new Error(`Renewal preparation refused: ${reply.outcome}`);
  return reply;
}
async function setup(kind: 'legacy-jwe' | 'canonical-token', knownAge = false) {
  const authSessionId = randomUUID();
  const authenticatedAt = knownAge ? new Date(Math.floor(Date.now() / 1_000) * 1_000 - 86_400_000) : null;
  let credential: BrowserSelectionCredential['credential'];
  if (kind === 'legacy-jwe')
    credential = {
      kind,
      secret,
      credential: await jwt.encode({
        secret,
        token: {
          sub: ownerId,
          authSessionId,
          gen: 0,
          ...(authenticatedAt ? { auth_time: authenticatedAt.getTime() / 1_000, link_guarded: true } : {}),
        },
        maxAge: 3_600,
      }),
    };
  else {
    const token = randomBytes(32).toString('base64url');
    const lineageId = `credential:${randomUUID()}`;
    await environment.database.insert(authSession).values({
      id: authSessionId,
      token,
      userId: ownerId,
      createdAt: new Date(Date.now() - 2 * 86_400_000),
      expiresAt: new Date(Date.now() + 3_600_000),
      updatedAt: new Date(),
      revocationGeneration: 0,
      originalAuthenticatedAt: authenticatedAt,
      legacyLineageId: lineageId,
    });
    await environment.database.insert(authCredentialLineage).values({
      id: lineageId,
      userId: ownerId,
      sessionId: authSessionId,
      originalAuthenticatedAt: authenticatedAt,
      originalExpiresAt: new Date(Date.now() - 86_400_000),
    });
    credential = { kind, token };
  }
  const created = await createUnpublishedBrowserBinding(
    environment.database,
    qualification,
    new Date(Date.now() + 86_400_000),
  );
  if (created.status !== 'created') throw new Error('Fixture binding refused');
  const intent = await beginBrowserIntent(environment.database, qualification, created.token, {
    operation: 'login',
    expectedVersion: 0,
  });
  if (intent.status !== 'prepared') throw new Error('Fixture login intent refused');
  const login = await commitBrowserLogin(
    environment.database,
    qualification,
    created.token,
    intent.intentToken,
    credential,
  );
  if (login.status !== 'committed') throw new Error('Fixture source publication refused');
  const actor = {
    version: 1,
    credential:
      credential.kind === 'canonical-token' ? credential : { kind: credential.kind, credential: credential.credential },
  };
  return { bindingToken: created.token, actor, actual: credential, authSessionId, authenticatedAt };
}
async function candidate(
  current: Awaited<ReturnType<typeof setup>>,
  result: Extract<BrowserRenewalReply, { outcome: 'prepared' }>,
) {
  if (current.actor.credential.kind === 'canonical-token') return current.actor.credential;
  const proof = result.preparation.sourceCredentialProof;
  const token = await jwt.encode({
    secret,
    token: {
      sub: proof.userId,
      authSessionId: proof.authSessionId,
      gen: proof.generation,
      ...(proof.authenticatedAt ? { auth_time: Date.parse(proof.authenticatedAt) / 1_000, link_guarded: true } : {}),
      ...(proof.requiresAccountCutoff ? { legacy_no_sid: true } : {}),
    },
    maxAge: Date.parse(result.preparation.targetExpiresAt) / 1_000 - Math.floor(Date.now() / 1_000),
  });
  expect((await jwt.decode({ secret, token }))?.exp).toBe(Date.parse(result.preparation.targetExpiresAt) / 1_000);
  return { kind: 'legacy-jwe' as const, credential: token };
}
function bound(
  current: Awaited<ReturnType<typeof setup>>,
  result: Extract<BrowserRenewalReply, { outcome: 'prepared' }>,
  renewed: Awaited<ReturnType<typeof candidate>>,
) {
  return {
    bindingToken: current.bindingToken,
    actor: current.actor,
    nonceHash,
    operationToken: result.operationToken,
    preparationToken: result.preparationToken,
    preparation: result.preparation,
    candidate: renewed,
  };
}

describe('ordinary selected-browser renewal transactions', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    for (const migration of ['0312_browser_binding_selection.sql', '0315_browser-renewals.sql'])
      await environment.client.unsafe(
        readFileSync(new URL(`../../../../../db/drizzle/${migration}`, import.meta.url), 'utf8'),
      );
  });
  beforeEach(async () => {
    await environment.client.unsafe(
      'TRUNCATE auth_browser_renewals, auth_browser_bindings, auth_email_projection, auth_migration_epochs, auth_subject_cutoffs, auth_session_denials, auth_security_mutation_events, auth_credential_lineage, users CASCADE',
    );
    ownerId = randomUUID();
    await environment.database.insert(users).values({ id: ownerId, email: `${ownerId}@example.test` });
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId: qualification.expectedProjectionId });
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
  });
  afterAll(async () => environment?.close());
  afterEach(() => vi.restoreAllMocks());
  for (const authority of ['current-store', 'better-auth'] as const)
    describe(authority, () => {
      beforeEach(async () => {
        await environment.database.transaction(async (transaction) => {
          const [manifest] = await transaction.select().from(authEmailProjection);
          if (manifest.writerAuthority !== authority)
            await switchIdentityAuthority(transaction, {
              projectionId: qualification.expectedProjectionId,
              from: manifest.writerAuthority,
              to: authority,
              epoch: manifest.writerEpoch,
            });
        });
      });
      for (const kind of ['legacy-jwe', 'canonical-token'] as const)
        describe(kind, () => {
          it.each([false, true])(
            'renews actual source with the same login/provenance and read-only ACK, knownAge=%s',
            async (knownAge) => {
              const current = await setup(kind, knownAge);
              const originalRows = await environment.database.select().from(authSession);
              const originalLineage = await environment.database.select().from(authCredentialLineage);
              const result = prepared(
                await invoke(
                  command('prepare', { bindingToken: current.bindingToken, actor: current.actor, nonceHash }),
                ),
              );
              const renewed = await candidate(current, result);
              const payload = bound(current, result, renewed);
              expect(await invoke(command('finalize', payload))).toMatchObject({
                outcome: 'completed',
                cursor: { version: 2 },
                credentialProof: {
                  userId: ownerId,
                  authSessionId: current.authSessionId,
                  generation: 0,
                  authenticatedAt: current.authenticatedAt?.toISOString() ?? null,
                },
              });
              expect(await invoke(command('acknowledge', payload))).toMatchObject({
                outcome: 'completed',
                cursor: { version: 2 },
              });
              expect(
                await readBrowserBinding(environment.database, qualification, current.bindingToken, {
                  version: 2,
                  credential: renewed.kind === 'canonical-token' ? renewed : { ...renewed, secret },
                }),
              ).toMatchObject({
                status: 'admitted',
                session: {
                  authSessionId: current.authSessionId,
                  generation: 0,
                  expiresAt: new Date(result.preparation.targetExpiresAt),
                },
              });
              const original = await environment.database.transaction((transaction) =>
                readFirstPartySession(transaction, current.actual, new Date(), (userId) =>
                  readLockedWebSubjectState(transaction, userId),
                ),
              );
              expect(original.status).toBe('admitted');
              expect(await environment.database.select().from(authSessionDenials)).toEqual([]);
              expect(await environment.database.select().from(authSubjectCutoffs)).toEqual([]);
              expect(await environment.database.select().from(authCredentialLineage)).toEqual(originalLineage);
              const rows = await environment.database.select().from(authSession);
              if (kind === 'canonical-token')
                expect(rows[0]).toEqual({
                  ...originalRows[0],
                  expiresAt: new Date(result.preparation.targetExpiresAt),
                  updatedAt: expect.any(Date),
                });
              else expect(rows).toEqual(originalRows);
              const [binding] = await environment.database.select().from(authBrowserBindings);
              expect(binding.expiresAt.getTime()).toBeGreaterThan(
                Date.parse(result.preparation.browserCursor.bindingExpiresAt),
              );
              const [stored] = await environment.database.select().from(authBrowserRenewals);
              expect(stored.resultVersion).toBe(2);
              expect(JSON.stringify(stored)).not.toContain(
                renewed.kind === 'canonical-token' ? renewed.token : renewed.credential,
              );
            },
          );
          it.each(['session', 'owner', 'future-expiry'] as const)(
            'refuses forged %s metadata without changing source or selection',
            async (field) => {
              const current = await setup(kind);
              const result = prepared(
                await invoke(
                  command('prepare', { bindingToken: current.bindingToken, actor: current.actor, nonceHash }),
                ),
              );
              const payload = bound(current, result, await candidate(current, result));
              const before = await environment.database.select().from(authSession);
              if (field === 'session') payload.preparation.sourceCredentialProof.authSessionId = randomUUID();
              if (field === 'owner') payload.preparation.sourceCredentialProof.userId = randomUUID();
              if (field === 'future-expiry')
                payload.preparation.futureBrowserCursor.bindingExpiresAt = new Date(
                  Date.parse(payload.preparation.futureBrowserCursor.bindingExpiresAt) + 86_400_000,
                ).toISOString();
              expect(await invoke(command('finalize', payload))).toMatchObject({ outcome: 'conflict' });
              expect(await environment.database.select().from(authSession)).toEqual(before);
              expect((await environment.database.select().from(authBrowserBindings))[0].version).toBe(1);
            },
          );
          it('rejects a different credential kind before extending a canonical mirror', async () => {
            const current = await setup(kind);
            const result = prepared(
              await invoke(command('prepare', { bindingToken: current.bindingToken, actor: current.actor, nonceHash })),
            );
            const payload = bound(current, result, await candidate(current, result));
            payload.candidate =
              kind === 'canonical-token'
                ? { kind: 'legacy-jwe', credential: 'refused-kind' }
                : { kind: 'canonical-token', token: randomBytes(32).toString('base64url') };
            const before = await environment.database.select().from(authSession);
            expect(await invoke(command('finalize', payload))).toMatchObject({ outcome: 'conflict' });
            expect(await environment.database.select().from(authSession)).toEqual(before);
            expect((await environment.database.select().from(authBrowserBindings))[0].version).toBe(1);
          });
          it('rolls back real writes when the final authority await crosses the operation deadline', async () => {
            const current = await setup(kind);
            const result = prepared(
              await invoke(command('prepare', { bindingToken: current.bindingToken, actor: current.actor, nonceHash })),
            );
            const payload = bound(current, result, await candidate(current, result));
            const [stored] = await environment.database.select().from(authBrowserRenewals);
            const clock = await environment.database.transaction(providerDatabaseNow);
            await environment.database
              .update(authBrowserRenewals)
              .set({ expiresAt: new Date(clock.getTime() + 500) })
              .where(eq(authBrowserRenewals.operationHash, stored.operationHash));
            const originalRows = await environment.database.select().from(authSession);
            const revalidate = authorityRouter.revalidateIdentityAuthority;
            let observedRealWrites = false;
            vi.spyOn(authorityRouter, 'revalidateIdentityAuthority').mockImplementation(
              async (transaction, authority) => {
                await revalidate(transaction, authority);
                if (observedRealWrites) return;
                const [pending] = await transaction
                  .select()
                  .from(authBrowserRenewals)
                  .where(eq(authBrowserRenewals.operationHash, stored.operationHash));
                if (pending?.completedAt) {
                  observedRealWrites = true;
                  await transaction.execute(sql`SELECT pg_sleep(0.6)`);
                }
              },
            );
            expect(await invoke(command('finalize', payload))).toMatchObject({ outcome: 'conflict' });
            expect(observedRealWrites).toBe(true);
            expect(await environment.database.select().from(authSession)).toEqual(originalRows);
            expect((await environment.database.select().from(authBrowserBindings))[0].version).toBe(1);
            expect((await environment.database.select().from(authBrowserRenewals))[0].completedAt).toBeNull();
          });
          it('lets an explicit pending account change take priority over ordinary renewal', async () => {
            const current = await setup(kind);
            const intent = await beginBrowserIntent(environment.database, qualification, current.bindingToken, {
              operation: 'login',
              expectedVersion: 1,
              presented: { version: 1, credential: current.actual },
            });
            expect(intent.status).toBe('prepared');
            expect(
              await invoke(command('prepare', { bindingToken: current.bindingToken, actor: current.actor, nonceHash })),
            ).toMatchObject({ outcome: 'conflict' });
            expect(await environment.database.select().from(authBrowserRenewals)).toEqual([]);
          });
          it('allows only one competing renewal to advance the selection', async () => {
            const current = await setup(kind);
            const first = prepared(
              await invoke(command('prepare', { bindingToken: current.bindingToken, actor: current.actor, nonceHash })),
            );
            const second = prepared(
              await invoke(command('prepare', { bindingToken: current.bindingToken, actor: current.actor, nonceHash })),
            );
            expect(
              await invoke(command('finalize', bound(current, first, await candidate(current, first)))),
            ).toMatchObject({ outcome: 'completed' });
            const before = await environment.database.select().from(authSession);
            expect(
              await invoke(command('finalize', bound(current, second, await candidate(current, second)))),
            ).toMatchObject({ outcome: 'conflict' });
            expect(await environment.database.select().from(authSession)).toEqual(before);
          });
        });
    });
});
