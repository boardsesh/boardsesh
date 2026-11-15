import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  authBrowserBindings,
  authBrowserIntents,
  authEmailProjection,
  authSession,
  authSubjectCutoffs,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import type {
  ExpiredBrowserBindingCommand,
  ExpiredBrowserBindingReply,
} from '@boardsesh/auth-protocol/expired-browser-binding-v1';
import { createEnvironment } from './environment';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../../current-store/foundation-context';
import { prepareProjectionUnderUsersTableLock } from '../../current-store/email-reservations';
import { readLockedWebSubjectState } from '../../current-store/web-credential-state';
import {
  beginBrowserIntent,
  commitBrowserLogin,
  createUnpublishedBrowserBinding,
  readBrowserBinding,
  type BrowserSelectionCredential,
} from '../browser-binding';
import { readFirstPartySession } from '../session-reader';
import { switchIdentityAuthority } from '../router';
import * as authorityRouter from '../router';
import {
  executeExpiredBrowserBindingCommand,
  EXPIRED_BROWSER_BINDING_RECEIPT_PREFIX,
} from '../expired-browser-binding';
import { deleteExpiredBrowserBindingRetirementReceipts } from '../expired-browser-binding-maintenance';

const webRequire = createRequire(new URL('../../../../../web/package.json', import.meta.url));
const jwt = webRequire('next-auth/jwt') as {
  encode(input: { secret: string; token: Record<string, unknown>; maxAge: number }): Promise<string>;
};
const secret = 'owned-expired-binding-reader-secret';
const qualification = {
  expectedProjectionId: randomUUID(),
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
};
const hash = (input: string) => createHash('sha256').update(input).digest('hex');
const freshToken = () => randomBytes(32).toString('base64url');
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let ownerId: string;
function command<Operation extends ExpiredBrowserBindingCommand['operation']>(
  operation: Operation,
  payload: Extract<ExpiredBrowserBindingCommand, { operation: Operation }>['payload'],
): ExpiredBrowserBindingCommand {
  return {
    expiredBrowserBindingProtocolVersion: 1,
    requestId: randomUUID(),
    issuedAt: Date.now(),
    operation,
    payload,
  } as ExpiredBrowserBindingCommand;
}
const invoke = (input: ExpiredBrowserBindingCommand) =>
  executeExpiredBrowserBindingCommand(environment.database, qualification, input);
function prepared(reply: ExpiredBrowserBindingReply) {
  expect(reply.outcome).toBe('prepared');
  if (reply.outcome !== 'prepared') throw new Error('Owned preparation failed');
  return reply;
}
function bound(bindingToken: string, reply: ReturnType<typeof prepared>) {
  return {
    bindingToken,
    targetBindingToken: reply.targetBindingToken,
    operationToken: reply.operationToken,
    preparation: reply.preparation,
  };
}
async function oldBinding(kind: 'anonymous' | 'legacy-jwe' | 'canonical-token' = 'anonymous', expired = true) {
  const created = await createUnpublishedBrowserBinding(environment.database, qualification);
  if (created.status !== 'created') throw new Error('Owned binding creation failed');
  let actor: BrowserSelectionCredential | undefined;
  if (kind !== 'anonymous') {
    const sessionId = randomUUID();
    let credential: BrowserSelectionCredential['credential'];
    if (kind === 'legacy-jwe')
      credential = {
        kind,
        secret,
        credential: await jwt.encode({
          secret,
          maxAge: 3_600,
          token: { sub: ownerId, authSessionId: sessionId, gen: 0 },
        }),
      };
    else {
      const token = freshToken();
      await environment.database.insert(authSession).values({
        id: sessionId,
        token,
        userId: ownerId,
        expiresAt: new Date(Date.now() + 3_600_000),
        updatedAt: new Date(),
        revocationGeneration: 0,
      });
      credential = { kind, token };
    }
    const intent = await beginBrowserIntent(environment.database, qualification, created.token, {
      operation: 'login',
      expectedVersion: 0,
    });
    if (intent.status !== 'prepared') throw new Error('Owned login intent failed');
    const selected = await commitBrowserLogin(
      environment.database,
      qualification,
      created.token,
      intent.intentToken,
      credential,
    );
    if (selected.status !== 'committed') throw new Error('Owned browser selection failed');
    actor = { version: 1, credential };
  }
  if (expired)
    await environment.database
      .update(authBrowserBindings)
      .set({ createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(authBrowserBindings.id, hash(created.token)));
  return { bindingToken: created.token, version: actor ? 1 : 0, actor };
}
const prepare = async (old: Awaited<ReturnType<typeof oldBinding>>) =>
  prepared(
    await invoke(
      command('prepare', { bindingToken: old.bindingToken, expectedVersion: old.version, nonceHash: 'a'.repeat(64) }),
    ),
  );
async function snapshot() {
  const rows = {
    bindings: await environment.database.select().from(authBrowserBindings).orderBy(authBrowserBindings.id),
    intents: await environment.database.select().from(authBrowserIntents).orderBy(authBrowserIntents.id),
    receipts: await environment.database
      .select()
      .from(verificationTokens)
      .orderBy(verificationTokens.identifier, verificationTokens.token),
    users: await environment.database.select().from(users).orderBy(users.id),
    sessions: await environment.database.select().from(authSession).orderBy(authSession.id),
    cutoffs: await environment.database.select().from(authSubjectCutoffs).orderBy(authSubjectCutoffs.userId),
  };
  return rows;
}
async function waitForUserLock(monitor: ReturnType<typeof postgres>, databaseName: string) {
  const end = Date.now() + 3_000;
  while (Date.now() < end) {
    const [row] = await monitor<
      { waiting: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=${databaseName} AND wait_event_type='Lock' AND query ILIKE '%users%for update%') AS waiting`;
    if (row.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Owned retirement did not reach the observed user lock');
}
/** Owner-only clock fixture for a genuine completed receipt near its fixed ACK
 * boundary. No production clock, lifetime option, signer or issuer is exposed. */
async function placeCompletedNearAck(
  old: Awaited<ReturnType<typeof oldBinding>>,
  result: ReturnType<typeof prepared>,
  remainingMilliseconds: number,
) {
  const [clock] = await environment.client<{ now: Date | string }[]>`SELECT clock_timestamp() AS now`;
  const preparedAt = new Date(new Date(clock.now).getTime() - 300_000 + remainingMilliseconds);
  const oldExpiry = new Date(preparedAt.getTime() - 1_000);
  await environment.database
    .update(authBrowserBindings)
    .set({ createdAt: new Date(preparedAt.getTime() - 60_000), expiresAt: oldExpiry })
    .where(eq(authBrowserBindings.id, hash(old.bindingToken)));
  result.preparation.preparedAt = preparedAt.toISOString();
  result.preparation.oldExpiresAt = oldExpiry.toISOString();
  result.preparation.expiresAt = new Date(preparedAt.getTime() + 60_000).toISOString();
  result.preparation.acknowledgeUntil = new Date(preparedAt.getTime() + 300_000).toISOString();
  result.preparation.targetCursor.bindingExpiresAt = new Date(preparedAt.getTime() + 30 * 86_400_000).toISOString();
  const precise = await environment.database.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
    return transaction
      .select({ state: sql<string>`to_jsonb(${authBrowserBindings})::text` })
      .from(authBrowserBindings)
      .where(eq(authBrowserBindings.id, hash(old.bindingToken)));
  });
  result.preparation.oldStateHash = hash(JSON.stringify(['expired-browser-binding-full-row-v1', precise[0].state]));
  await environment.database
    .update(authBrowserBindings)
    .set({ createdAt: preparedAt, expiresAt: new Date(result.preparation.targetCursor.bindingExpiresAt) })
    .where(eq(authBrowserBindings.id, result.preparation.targetCursor.bindingId));
  await environment.database
    .update(verificationTokens)
    .set({
      token: hash(
        JSON.stringify([
          'expired-browser-binding-receipt-v1',
          'completed',
          hash(result.operationToken),
          result.preparation,
        ]),
      ),
      expires: new Date(result.preparation.acknowledgeUntil),
    })
    .where(
      eq(verificationTokens.identifier, `${EXPIRED_BROWSER_BINDING_RECEIPT_PREFIX}${hash(result.operationToken)}`),
    );
}

describe('explicit expired-binding retirement on actual PostgreSQL', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
    await environment.client.unsafe(
      readFileSync(new URL('../../../../../db/drizzle/0312_browser_binding_selection.sql', import.meta.url), 'utf8'),
    );
  });
  beforeEach(async () => {
    await environment.client.unsafe(
      'TRUNCATE auth_browser_bindings, "verificationTokens", auth_email_projection, auth_migration_epochs, auth_subject_cutoffs, auth_session_denials, auth_security_mutation_events, auth_credential_lineage, users CASCADE',
    );
    ownerId = randomUUID();
    await environment.database.insert(users).values({ id: ownerId, email: `${ownerId}@example.test` });
    await environment.database.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId: qualification.expectedProjectionId });
      await transaction.update(authEmailProjection).set({ phase: 'enforced' });
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  afterAll(async () => environment?.close());
  for (const authority of ['current-store', 'better-auth'] as const)
    describe(authority, () => {
      beforeEach(async () => {
        if (authority === 'better-auth')
          await environment.database.transaction((transaction) =>
            switchIdentityAuthority(transaction, {
              projectionId: qualification.expectedProjectionId,
              from: 'current-store',
              to: 'better-auth',
              epoch: 1,
            }),
          );
      });
      it.each(['anonymous', 'legacy-jwe', 'canonical-token'] as const)(
        'creates a distinct anonymous target and leaves expired %s and principal state unchanged',
        async (kind) => {
          const old = await oldBinding(kind);
          const initial = await snapshot();
          const result = await prepare(old);
          const afterPrepare = await snapshot();
          expect(afterPrepare.bindings).toEqual(initial.bindings);
          expect(afterPrepare.sessions).toEqual(initial.sessions);
          expect(afterPrepare.users).toEqual(initial.users);
          expect(afterPrepare.receipts).toHaveLength(1);
          expect(JSON.stringify(afterPrepare.receipts)).not.toContain(old.bindingToken);
          expect(JSON.stringify(afterPrepare.receipts)).not.toContain(result.targetBindingToken);
          expect(JSON.stringify(afterPrepare.receipts)).not.toContain(result.operationToken);
          const payload = bound(old.bindingToken, result);
          expect((await invoke(command('finalize', payload))).outcome).toBe('completed');
          const committed = await snapshot();
          expect(committed.bindings.find((row) => row.id === hash(old.bindingToken))).toEqual(initial.bindings[0]);
          expect(committed.users).toEqual(initial.users);
          expect(committed.sessions).toEqual(initial.sessions);
          expect(committed.cutoffs).toEqual(initial.cutoffs);
          expect(committed.intents).toEqual(initial.intents);
          expect(committed.bindings).toHaveLength(2);
          expect(
            await readBrowserBinding(environment.database, qualification, old.bindingToken, old.actor),
          ).toMatchObject({ status: 'denied' });
          expect(
            await readBrowserBinding(environment.database, qualification, result.targetBindingToken),
          ).toMatchObject({ status: 'anonymous', cursor: { version: 0 } });
          if (old.actor) {
            const credential = old.actor.credential;
            const ordinary = await environment.database.transaction((transaction) =>
              readFirstPartySession(transaction, credential, new Date(), (userId) =>
                readLockedWebSubjectState(transaction, userId),
              ),
            );
            expect(ordinary.status).toBe('admitted');
          }
          expect((await invoke(command('acknowledge', payload))).outcome).toBe('completed');
          expect(await snapshot()).toEqual(committed);
          expect((await invoke(command('finalize', payload))).outcome).toBe('conflict');
          expect(await snapshot()).toEqual(committed);
        },
      );
      it.each(['anonymous', 'legacy-jwe', 'canonical-token'] as const)(
        'never converts a live %s binding into a retirement, even with missing proof',
        async (kind) => {
          const old = await oldBinding(kind, false);
          const before = await snapshot();
          expect(
            (
              await invoke(
                command('prepare', {
                  bindingToken: old.bindingToken,
                  expectedVersion: old.version,
                  nonceHash: 'b'.repeat(64),
                }),
              )
            ).outcome,
          ).toBe('denied');
          expect(await snapshot()).toEqual(before);
        },
      );
      it('does not treat an unknown correlation token as an anonymous binding', async () => {
        const before = await snapshot();
        expect(
          (
            await invoke(
              command('prepare', { bindingToken: freshToken(), expectedVersion: 0, nonceHash: 'b'.repeat(64) }),
            )
          ).outcome,
        ).toBe('denied');
        expect(await snapshot()).toEqual(before);
      });
      it('requires the expected old version before recording preparation', async () => {
        const old = await oldBinding();
        const before = await snapshot();
        expect(
          (
            await invoke(
              command('prepare', { bindingToken: old.bindingToken, expectedVersion: 1, nonceHash: 'b'.repeat(64) }),
            )
          ).outcome,
        ).toBe('conflict');
        expect(await snapshot()).toEqual(before);
      });
      it.each(['anonymous', 'canonical-token'] as const)(
        'freezes the actual expired %s row when a fresh page has no readable version',
        async (kind) => {
          const old = await oldBinding(kind);
          const result = prepared(
            await invoke(command('prepare', { bindingToken: old.bindingToken, nonceHash: 'a'.repeat(64) })),
          );
          expect(result.preparation.oldVersion).toBe(old.version);
          expect((await invoke(command('finalize', bound(old.bindingToken, result)))).outcome).toBe('completed');
        },
      );
      it.each([
        'old-token',
        'target-token',
        'operation-token',
        'nonce',
        'expiry',
        'authority',
        'target-expiry',
      ] as const)('rejects prepared %s drift without writes', async (change) => {
        const old = await oldBinding('canonical-token');
        const result = await prepare(old);
        const payload = structuredClone(bound(old.bindingToken, result));
        if (change === 'old-token') payload.bindingToken = freshToken();
        if (change === 'target-token') payload.targetBindingToken = freshToken();
        if (change === 'operation-token') payload.operationToken = freshToken();
        if (change === 'nonce') payload.preparation.nonceHash = 'c'.repeat(64);
        if (change === 'expiry')
          payload.preparation.expiresAt = new Date(Date.parse(payload.preparation.expiresAt) - 1).toISOString();
        if (change === 'authority') payload.preparation.authority.epoch += 1;
        if (change === 'target-expiry') {
          // Keep a structurally valid plan while moving both frozen clocks.
          const shifted = (value: string) => new Date(Date.parse(value) + 1).toISOString();
          payload.preparation.preparedAt = shifted(payload.preparation.preparedAt);
          payload.preparation.expiresAt = shifted(payload.preparation.expiresAt);
          payload.preparation.acknowledgeUntil = shifted(payload.preparation.acknowledgeUntil);
          payload.preparation.targetCursor.bindingExpiresAt = shifted(
            payload.preparation.targetCursor.bindingExpiresAt,
          );
        }
        const before = await snapshot();
        expect((await invoke(command('finalize', payload))).outcome).not.toBe('completed');
        expect(await snapshot()).toEqual(before);
      });
      it('requires durable completion even when the actual target independently exists', async () => {
        const old = await oldBinding();
        const result = await prepare(old);
        await environment.database.insert(authBrowserBindings).values({
          id: result.preparation.targetCursor.bindingId,
          createdAt: new Date(result.preparation.preparedAt),
          expiresAt: new Date(result.preparation.targetCursor.bindingExpiresAt),
        });
        const before = await snapshot();
        expect((await invoke(command('acknowledge', bound(old.bindingToken, result)))).outcome).toBe('conflict');
        expect((await invoke(command('finalize', bound(old.bindingToken, result)))).outcome).toBe('conflict');
        expect(await snapshot()).toEqual(before);
      });
      it.each(['intent', 'selected'] as const)('does not overwrite a target after %s progress', async (progress) => {
        const old = await oldBinding();
        const result = await prepare(old);
        const payload = bound(old.bindingToken, result);
        expect((await invoke(command('finalize', payload))).outcome).toBe('completed');
        const intent = await beginBrowserIntent(environment.database, qualification, result.targetBindingToken, {
          operation: 'login',
          expectedVersion: 0,
        });
        expect(intent.status).toBe('prepared');
        if (progress === 'selected') {
          if (intent.status !== 'prepared') throw new Error('Owned target login intent failed');
          const other = await oldBinding('canonical-token', false);
          if (!other.actor) throw new Error('Owned target login credential failed');
          expect(
            (
              await commitBrowserLogin(
                environment.database,
                qualification,
                result.targetBindingToken,
                intent.intentToken,
                other.actor.credential,
              )
            ).status,
          ).toBe('committed');
        }
        const afterIntent = await snapshot();
        expect((await invoke(command('acknowledge', payload))).outcome).toBe('conflict');
        expect(await snapshot()).toEqual(afterIntent);
      });
      it('rejects any old-row mutation, including timestamp changes below one millisecond', async () => {
        const old = await oldBinding('canonical-token');
        const result = await prepare(old);
        await environment.database.execute(
          sql`UPDATE ${authBrowserBindings} SET created_at=created_at+interval '1 microsecond' WHERE id=${result.preparation.oldBindingId}`,
        );
        const before = await snapshot();
        expect((await invoke(command('finalize', bound(old.bindingToken, result)))).outcome).toBe('conflict');
        expect(await snapshot()).toEqual(before);
      });
      it.each(['created_at', 'expires_at'] as const)(
        'refuses an actual target %s change below one millisecond before read-only ACK',
        async (column) => {
          const old = await oldBinding('canonical-token');
          const result = await prepare(old);
          const boundInput = bound(old.bindingToken, result);
          expect((await invoke(command('finalize', boundInput))).outcome).toBe('completed');
          const precise = () =>
            environment.database
              .select({ state: sql<string>`to_jsonb(${authBrowserBindings})::text` })
              .from(authBrowserBindings)
              .where(eq(authBrowserBindings.id, result.preparation.targetCursor.bindingId));
          const beforeChange = await precise();
          await environment.database.execute(
            sql`UPDATE ${authBrowserBindings} SET ${sql.identifier(column)}=${sql.identifier(column)}+interval '1 microsecond' WHERE id=${result.preparation.targetCursor.bindingId}`,
          );
          const changed = await precise();
          expect(changed).not.toEqual(beforeChange);
          const beforeAck = await snapshot();
          expect((await invoke(command('acknowledge', boundInput))).outcome).toBe('conflict');
          expect(await precise()).toEqual(changed);
          expect(await snapshot()).toEqual(beforeAck);
        },
      );
      it.each(['finalize', 'acknowledge'] as const)(
        'refuses an authority switch before %s without touching state',
        async (operation) => {
          const old = await oldBinding('canonical-token');
          const result = await prepare(old);
          if (operation === 'acknowledge')
            expect((await invoke(command('finalize', bound(old.bindingToken, result)))).outcome).toBe('completed');
          await environment.database.transaction((transaction) =>
            switchIdentityAuthority(transaction, {
              projectionId: qualification.expectedProjectionId,
              from: authority,
              to: authority === 'current-store' ? 'better-auth' : 'current-store',
              epoch: authority === 'current-store' ? 1 : 2,
            }),
          );
          const before = await snapshot();
          expect((await invoke(command(operation, bound(old.bindingToken, result)))).outcome).toBe('conflict');
          expect(await snapshot()).toEqual(before);
        },
      );
      it('allows only read-only ACK after the original operation deadline without extending it', async () => {
        const old = await oldBinding('canonical-token');
        const result = await prepare(old);
        expect((await invoke(command('finalize', bound(old.bindingToken, result)))).outcome).toBe('completed');
        await placeCompletedNearAck(old, result, 10_000);
        const before = await snapshot();
        expect((await invoke(command('acknowledge', bound(old.bindingToken, result)))).outcome).toBe('completed');
        expect((await invoke(command('finalize', bound(old.bindingToken, result)))).outcome).toBe('conflict');
        expect(await snapshot()).toEqual(before);
      });
      it('checks the durable ACK deadline after the final actual authority await', async () => {
        const old = await oldBinding('canonical-token');
        const result = await prepare(old);
        expect((await invoke(command('finalize', bound(old.bindingToken, result)))).outcome).toBe('completed');
        await placeCompletedNearAck(old, result, 250);
        const before = await snapshot();
        const original = authorityRouter.revalidateIdentityAuthority;
        const revalidate = vi
          .spyOn(authorityRouter, 'revalidateIdentityAuthority')
          .mockImplementation(async (transaction, receipt) => {
            await original(transaction, receipt);
            await transaction.execute(sql`SELECT pg_sleep(0.4)`);
          });
        expect((await invoke(command('acknowledge', bound(old.bindingToken, result)))).outcome).toBe('conflict');
        expect(revalidate).toHaveBeenCalledOnce();
        expect(await snapshot()).toEqual(before);
      });
      it('does not let host-clock advancement retire a database-live selection', async () => {
        const old = await oldBinding('canonical-token', false);
        const before = await snapshot();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 31 * 86_400_000);
        expect(
          (
            await invoke(
              command('prepare', {
                bindingToken: old.bindingToken,
                expectedVersion: old.version,
                nonceHash: 'a'.repeat(64),
              }),
            )
          ).outcome,
        ).toBe('denied');
        expect(await snapshot()).toEqual(before);
      });
      it('cleans only database-expired own-purpose receipts, in a bounded batch even with a future host clock', async () => {
        const now = new Date();
        const own = (label: string, expires: Date) => ({
          identifier: `${EXPIRED_BROWSER_BINDING_RECEIPT_PREFIX}${label}`,
          token: hash(label),
          expires,
        });
        const expired = Array.from({ length: 1_001 }, (_, index) =>
          own(`expired-${index}`, new Date(now.getTime() - 10_000)),
        );
        const live = own('live', new Date(now.getTime() + 60_000));
        const unrelated = {
          identifier: `ba03-web-auth:${hash('unrelated')}`,
          token: hash('unrelated'),
          expires: new Date(now.getTime() - 10_000),
        };
        await environment.database.insert(verificationTokens).values([...expired, live, unrelated]);
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(now.getTime() + 86_400_000);
        expect(await deleteExpiredBrowserBindingRetirementReceipts(environment.database)).toBe(1_000);
        expect(await deleteExpiredBrowserBindingRetirementReceipts(environment.database)).toBe(1);
        expect(
          await environment.database.select().from(verificationTokens).orderBy(verificationTokens.identifier),
        ).toEqual([live, unrelated].sort((left, right) => left.identifier.localeCompare(right.identifier)));
      });
      it('isolates email/reset/command/native receipt namespaces and rejects duplicate operation rows', async () => {
        const old = await oldBinding();
        const result = await prepare(old);
        const [receipt] = await environment.database.select().from(verificationTokens);
        expect(receipt.identifier.startsWith(EXPIRED_BROWSER_BINDING_RECEIPT_PREFIX)).toBe(true);
        await environment.database.insert(verificationTokens).values([
          { identifier: `${ownerId}@example.test`, token: 'email-token', expires: new Date(Date.now() + 60_000) },
          {
            identifier: `password-reset:${ownerId}@example.test`,
            token: 'reset-token',
            expires: new Date(Date.now() + 60_000),
          },
          {
            identifier: `ba03-web-auth:${hash(result.operationToken)}`,
            token: receipt.token,
            expires: receipt.expires,
          },
          {
            identifier: `ba03-native-handoff-v1:${hash(result.operationToken)}`,
            token: receipt.token,
            expires: receipt.expires,
          },
        ]);
        expect((await invoke(command('finalize', bound(old.bindingToken, result)))).outcome).toBe('completed');
        const after = await snapshot();
        expect(
          after.receipts.filter((row) => !row.identifier.startsWith(EXPIRED_BROWSER_BINDING_RECEIPT_PREFIX)),
        ).toHaveLength(4);
        await environment.database.insert(verificationTokens).values({ ...receipt, token: 'f'.repeat(64) });
        const duplicate = await snapshot();
        expect((await invoke(command('acknowledge', bound(old.bindingToken, result)))).outcome).toBe('denied');
        expect(await snapshot()).toEqual(duplicate);
      });
      it('rechecks the old row after an actually observed user-lock wait', async () => {
        const old = await oldBinding('canonical-token');
        const result = await prepare(old);
        const [{ name }] = await environment.client<{ name: string }[]>`SELECT current_database() AS name`;
        const monitor = postgres(process.env.AUTH_PROTOTYPE_DATABASE_URL!, { max: 1, onnotice() {} });
        let release!: () => void;
        let signalHeld!: () => void;
        const held = new Promise<void>((resolve) => {
          signalHeld = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const holding = environment.database.transaction(async (transaction) => {
          await transaction.select().from(users).where(eq(users.id, ownerId)).for('update');
          signalHeld();
          await barrier;
          await transaction
            .update(authBrowserBindings)
            .set({ intentRevision: 99 })
            .where(eq(authBrowserBindings.id, result.preparation.oldBindingId));
        });
        let pending: Promise<ExpiredBrowserBindingReply> | undefined;
        try {
          await held;
          pending = invoke(command('finalize', bound(old.bindingToken, result)));
          await waitForUserLock(monitor, name);
          release();
          await holding;
          expect((await pending).outcome).toBe('conflict');
          expect((await snapshot()).bindings).toHaveLength(1);
        } finally {
          release();
          await Promise.allSettled([holding, ...(pending ? [pending] : [])]);
          await monitor.end({ timeout: 2 });
        }
      });
      it('rolls back the actual new binding and receipt completion when a post-insert wait crosses the DB deadline', async () => {
        const old = await oldBinding('canonical-token');
        const result = await prepare(old);
        const now = await environment.client<{ now: Date | string }[]>`SELECT clock_timestamp() AS now`;
        result.preparation.expiresAt = new Date(new Date(now[0].now).getTime() + 250).toISOString();
        // Owner-only fixture shortens a genuine plan and its durable hash. The
        // production API has no clock/policy override or preparation signer.
        const fixtureHash = hash(
          JSON.stringify([
            'expired-browser-binding-receipt-v1',
            'prepared',
            hash(result.operationToken),
            result.preparation,
          ]),
        );
        await environment.database.update(verificationTokens).set({ token: fixtureHash });
        await environment.client.unsafe(
          `CREATE FUNCTION owned_retirement_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$; CREATE TRIGGER owned_retirement_delay AFTER INSERT ON auth_browser_bindings FOR EACH ROW EXECUTE FUNCTION owned_retirement_delay()`,
        );
        try {
          const before = await snapshot();
          expect((await invoke(command('finalize', bound(old.bindingToken, result)))).outcome).toBe('conflict');
          expect(await snapshot()).toEqual(before);
        } finally {
          await environment.client.unsafe(
            'DROP TRIGGER owned_retirement_delay ON auth_browser_bindings; DROP FUNCTION owned_retirement_delay()',
          );
        }
      });
    });
});
