import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@boardsesh/db/schema';
import postgres from 'postgres';
import { cleanupNativeRefreshRows } from '../native-refresh-retention';
import {
  authSecurityMutationEvents,
  authSessionDenials,
  authCredentialLineage,
  mobileRefreshTokens,
  users,
} from '@boardsesh/db/schema';
import { bindNativeRefreshSession } from '../native-session';
import { denyFirstPartySessionInTransaction } from '../lineage';
import { requireHumanSubjectForIssuance } from '../../human-admission';
import { createEnvironment } from './environment';

let environment: Awaited<ReturnType<typeof createEnvironment>>;
beforeAll(async () => {
  environment = await createEnvironment();
});
afterAll(async () => environment?.close());
afterEach(() => vi.unstubAllEnvs());

function event(kind: 'native-signout' | 'admin-revocation', userId = randomUUID()) {
  const native = kind === 'native-signout';
  return {
    operationId: randomUUID(),
    userId,
    kind,
    generation: native ? 0 : 1,
    previousGeneration: 0,
    nativeGeneration: native ? 1 : null,
    previousNativeGeneration: native ? 0 : null,
    domains: native ? (['first-party'] as ['first-party']) : (['first-party', 'partner'] as ['first-party', 'partner']),
    revokedThrough: new Date(),
    writerEpoch: native ? 0 : 1,
    projectionId: native ? 'legacy-native' : 'enforced-integration-review',
  };
}

it('rejects an unknown event kind through the generated migration', async () => {
  await expect(environment.client`
    INSERT INTO auth_security_mutation_events
      (operation_id, user_id, generation, previous_generation, kind, domains, revoked_through, writer_epoch, projection_id)
    VALUES (${randomUUID()}, ${randomUUID()}, 1, 0, 'operator-bypass', ARRAY['first-party', 'partner'], now(), 1, 'integration-review')
  `).rejects.toMatchObject({ code: '23514', constraint_name: 'auth_security_mutation_events_kind' });
});

it.each(['native-signout', 'admin-revocation'] as const)(
  'rejects unsupported payload versions and negative epochs for %s',
  async (kind) => {
    for (const invalid of [{ payloadVersion: 2 }, { writerEpoch: -1 }]) {
      await expect(
        environment.database.insert(authSecurityMutationEvents).values({ ...event(kind), ...invalid }),
      ).rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'auth_security_mutation_events_epoch' } });
    }
  },
);

it('enforces independent native and account generation uniqueness', async () => {
  const userId = randomUUID();
  const native = event('native-signout', userId);
  const account = event('admin-revocation', userId);
  await environment.database.insert(authSecurityMutationEvents).values([native, account]);
  for (const [existing, constraint] of [
    [native, 'auth_security_mutation_events_native_generation_idx'],
    [account, 'auth_security_mutation_events_generation_idx'],
  ] as const) {
    await expect(
      environment.database.insert(authSecurityMutationEvents).values({ ...existing, operationId: randomUUID() }),
    ).rejects.toMatchObject({ cause: { code: '23505', constraint_name: constraint } });
  }
  await environment.database.insert(authSecurityMutationEvents).values({
    ...native,
    operationId: randomUUID(),
    nativeGeneration: 2,
    previousNativeGeneration: 1,
  });
});

it('retains a native SID denial through source expiry and prevents canonical rebinding', async () => {
  const userId = randomUUID();
  const sessionId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 45 * 86400000);
  const proof = { sessionId, subjectGeneration: 0, authenticatedAt: null };
  await environment.database.insert(users).values({ id: userId, email: `native-integration-${userId}@example.test` });
  vi.stubEnv('AUTH_LEGACY_BRIDGE_MODE', 'on');
  const bind = () =>
    environment.database.transaction(async (transaction) => {
      await requireHumanSubjectForIssuance(transaction, userId);
      await bindNativeRefreshSession(transaction, userId, proof, expiresAt, now, 'generation');
    });
  await bind();
  const deny = (sourceExpiresAt: Date) =>
    environment.database.transaction(async (transaction) => {
      await requireHumanSubjectForIssuance(transaction, userId);
      await denyFirstPartySessionInTransaction(
        transaction,
        {
          userId,
          authSessionId: sessionId,
          generation: 0,
          requiresAccountCutoff: false,
          authenticatedAt: null,
          expiresAt: sourceExpiresAt,
        },
        now,
      );
    });
  await deny(expiresAt);
  await deny(new Date(now.getTime() + 3600000));
  const [denial] = await environment.database
    .select()
    .from(authSessionDenials)
    .where(eq(authSessionDenials.sessionId, sessionId));
  expect(denial.expiresAt.getTime()).toBe(expiresAt.getTime() + 60000);
  await environment.database.delete(authCredentialLineage).where(eq(authCredentialLineage.userId, userId));
  await expect(bind()).rejects.toThrow('Authentication is required');
});

it('retains a parent when cleanup overlaps its last-moment refresh child issuance', async () => {
  const userId = randomUUID();
  const parentHash = randomUUID();
  const expiresAt = new Date(Date.now() + 60000);
  const cleanupAt = new Date(expiresAt.getTime() + 1);
  await environment.database.insert(users).values({ id: userId, email: `native-race-${userId}@example.test` });
  await environment.database.insert(mobileRefreshTokens).values({ userId, tokenHash: parentHash, expiresAt });
  let consumed!: () => void;
  let release!: () => void;
  const parentConsumed = new Promise<void>((resolve) => {
    consumed = resolve;
  });
  const finishRefresh = new Promise<void>((resolve) => {
    release = resolve;
  });
  const issuing = environment.database.transaction(async (transaction) => {
    await requireHumanSubjectForIssuance(transaction, userId);
    expect(Date.now()).toBeLessThan(expiresAt.getTime());
    await transaction
      .update(mobileRefreshTokens)
      .set({ revokedAt: expiresAt })
      .where(eq(mobileRefreshTokens.tokenHash, parentHash));
    consumed();
    await finishRefresh;
    await transaction
      .insert(mobileRefreshTokens)
      .values({ userId, tokenHash: randomUUID(), expiresAt: new Date(cleanupAt.getTime() + 86400000) });
  });
  await parentConsumed;
  const cleanup = cleanupNativeRefreshRows(environment.database, cleanupAt);
  const observer = postgres(
    process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
    { max: 1 },
  );
  let blockedCleanup = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const waiting =
        await observer`SELECT 1 FROM pg_stat_activity WHERE datname = ${environment.client.options.database} AND wait_event_type = 'Lock' AND ((query LIKE '%delete from "mobile_refresh_tokens"%') OR (query LIKE '%from "users"%' AND query LIKE '%for update%'))`;
      if (waiting.length) {
        blockedCleanup = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    release();
    await observer.end({ timeout: 5 });
  }
  await issuing;
  const removed = await cleanup;
  expect(blockedCleanup).toBe(true);
  expect(removed).toBe(0);
  expect(
    await environment.database.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, userId)),
  ).toHaveLength(2);
});

it('captures cleanup time before asynchronous candidate discovery', async () => {
  const userId = randomUUID();
  const now = new Date();
  const requestedNow = new Date(now);
  await environment.database.insert(users).values({ id: userId, email: `cleanup-clock-${userId}@example.test` });
  await environment.database.insert(mobileRefreshTokens).values([
    { userId, tokenHash: randomUUID(), expiresAt: new Date(now.getTime() - 86400000), revokedAt: now },
    { userId, tokenHash: randomUUID(), expiresAt: new Date(now.getTime() + 3600000) },
  ]);
  const cleanup = cleanupNativeRefreshRows(environment.database, requestedNow);
  requestedNow.setTime(now.getTime() + 2 * 3600000);
  expect(await cleanup).toBe(0);
  expect(
    await environment.database.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, userId)),
  ).toHaveLength(2);
});

it('refuses cleanup writes under repeatable-read isolation', async () => {
  const userId = randomUUID();
  const now = new Date();
  await environment.database.insert(users).values({ id: userId, email: `cleanup-isolation-${userId}@example.test` });
  await environment.database
    .insert(mobileRefreshTokens)
    .values({ userId, tokenHash: randomUUID(), expiresAt: new Date(now.getTime() - 86400000) });
  const address = new URL(
    process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
  );
  address.pathname = `/${environment.client.options.database}`;
  const isolatedClient = postgres(address.toString(), {
    max: 1,
    connection: { default_transaction_isolation: 'repeatable read' },
  });
  try {
    const isolatedDatabase = drizzle(isolatedClient, { schema });
    await expect(cleanupNativeRefreshRows(isolatedDatabase, now)).rejects.toMatchObject({
      code: 'UNSUPPORTED_ISOLATION',
    });
    expect(
      await environment.database.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, userId)),
    ).toHaveLength(1);
  } finally {
    await isolatedClient.end({ timeout: 5 });
  }
});

it('waits at the shared authority gate before cleanup can remove refresh evidence', async () => {
  const userId = randomUUID();
  const now = new Date();
  await environment.database.insert(users).values({ id: userId, email: `cleanup-gate-${userId}@example.test` });
  await environment.database
    .insert(mobileRefreshTokens)
    .values({ userId, tokenHash: randomUUID(), expiresAt: new Date(now.getTime() - 86400000) });
  let gateLocked!: () => void;
  let releaseGate!: () => void;
  const locked = new Promise<void>((resolve) => {
    gateLocked = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const switching = environment.database.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975, 2)`);
    gateLocked();
    await released;
  });
  await locked;
  const cleanup = cleanupNativeRefreshRows(environment.database, now);
  const observer = postgres(
    process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
    { max: 1 },
  );
  let gateWaitObserved = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const waiting =
        await observer`SELECT 1 FROM pg_stat_activity WHERE datname = ${environment.client.options.database} AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock_shared%'`;
      if (waiting.length) {
        gateWaitObserved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    releaseGate();
    await observer.end({ timeout: 5 });
  }
  await switching;
  const removed = await cleanup;
  expect(gateWaitObserved).toBe(true);
  expect(removed).toBeGreaterThanOrEqual(1);
  expect(
    await environment.database.select().from(mobileRefreshTokens).where(eq(mobileRefreshTokens.userId, userId)),
  ).toHaveLength(0);
});
