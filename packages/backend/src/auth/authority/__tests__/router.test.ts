import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { authEmailProjection, authMigrationEpochs } from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { CURRENT_EMAIL_NORMALIZER_VERSION, lockEnforcedProjection } from '../../current-store/foundation-context';
import { readIdentityAuthority, revalidateIdentityAuthority, switchIdentityAuthority, issuerFor } from '../router';

let environment: Awaited<ReturnType<typeof createEnvironment>>;
const projectionId = randomUUID();
const qualification = {
  expectedProjectionId: projectionId,
  expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
};
describe('per-command manifest authority and epoch', () => {
  beforeAll(async () => {
    environment = await createEnvironment();
  });
  afterAll(async () => environment?.close());
  beforeEach(async () => {
    await environment.database.delete(authMigrationEpochs);
    await environment.database.delete(authEmailProjection);
    await environment.database.insert(authEmailProjection).values({
      projectionId,
      normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      phase: 'enforced',
      writerEpoch: 1,
      preparedAt: new Date(),
    });
  });
  it('defaults current-store and observes both live switch and rollback without a process restart', async () => {
    const first = await readIdentityAuthority(environment.database, qualification);
    expect(first).toMatchObject({ authority: 'current-store', epoch: 1 });
    await environment.database.transaction((tx) =>
      switchIdentityAuthority(tx, { projectionId, epoch: 1, from: 'current-store', to: 'better-auth' }),
    );
    expect(await readIdentityAuthority(environment.database, qualification)).toMatchObject({
      authority: 'better-auth',
      epoch: 2,
    });
    await expect(environment.database.transaction((tx) => revalidateIdentityAuthority(tx, first))).rejects.toThrow(
      'STALE_AUTHORITY',
    );
    await environment.database.transaction((tx) =>
      switchIdentityAuthority(tx, { projectionId, epoch: 2, from: 'better-auth', to: 'current-store' }),
    );
    expect(await readIdentityAuthority(environment.database, qualification)).toMatchObject({
      authority: 'current-store',
      epoch: 3,
    });
    expect(await environment.database.select().from(authMigrationEpochs)).toHaveLength(2);
    expect(issuerFor(randomUUID())).toBe('legacy');
  });
  it('rolls the manifest and epoch evidence back together', async () => {
    await expect(
      environment.database.transaction(async (tx) => {
        await switchIdentityAuthority(tx, { projectionId, epoch: 1, from: 'current-store', to: 'better-auth' });
        throw new Error('injected failure');
      }),
    ).rejects.toThrow('injected failure');
    expect(await readIdentityAuthority(environment.database, qualification)).toMatchObject({
      authority: 'current-store',
      epoch: 1,
    });
    expect(await environment.database.select().from(authMigrationEpochs)).toHaveLength(0);
  });
  it('refuses stale expected epochs, projections and malformed commands without writes', async () => {
    for (const change of [
      { projectionId, epoch: 2, from: 'current-store', to: 'better-auth' },
      { projectionId: randomUUID(), epoch: 1, from: 'current-store', to: 'better-auth' },
      { projectionId, epoch: 1, from: 'current-store', to: 'current-store' },
      { projectionId, epoch: 2_147_483_647, from: 'current-store', to: 'better-auth' },
    ] as const) {
      await expect(environment.database.transaction((tx) => switchIdentityAuthority(tx, change))).rejects.toThrow();
    }
    expect(await readIdentityAuthority(environment.database, qualification)).toMatchObject({
      authority: 'current-store',
      epoch: 1,
    });
    const [manifest] = await environment.database
      .select()
      .from(authEmailProjection)
      .where(eq(authEmailProjection.projectionId, projectionId));
    expect(manifest.writerEpoch).toBe(1);
  });
  it('waits for the exclusive gate before reading the committed manifest', async () => {
    let held!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      held = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const switching = environment.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(6975, 2)`);
      await transaction
        .update(authEmailProjection)
        .set({ writerAuthority: 'better-auth', writerEpoch: 2 })
        .where(eq(authEmailProjection.projectionId, projectionId));
      held();
      await proceed;
    });
    await ready;
    const capture = readIdentityAuthority(environment.database, qualification);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      release();
      await switching;
      expect(await capture).toMatchObject({ authority: 'better-auth', epoch: 2 });
    } finally {
      release();
      await switching;
      await capture.catch(() => undefined);
    }
  });

  it('an in-flight shared command makes switch fail at its bounded exclusive lock timeout', async () => {
    let held!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      held = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const command = environment.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock_shared(6975, 2)`);
      held();
      await proceed;
    });
    await ready;
    try {
      await expect(
        environment.database.transaction((transaction) =>
          switchIdentityAuthority(transaction, { projectionId, epoch: 1, from: 'current-store', to: 'better-auth' }),
        ),
      ).rejects.toThrow();
    } finally {
      release();
      await command;
    }
    expect(await readIdentityAuthority(environment.database, qualification)).toMatchObject({
      authority: 'current-store',
      epoch: 1,
    });
  });

  it('rejects repeatable-read capture and preserves the old explicit-epoch caller contract', async () => {
    await expect(
      environment.database.transaction(
        (transaction) =>
          revalidateIdentityAuthority(transaction, {
            projectionId,
            normalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
            epoch: 1,
            authority: 'current-store',
          }),
        { isolationLevel: 'repeatable read' },
      ),
    ).rejects.toThrow();
    await expect(
      environment.database.transaction((transaction) =>
        lockEnforcedProjection(transaction, { ...qualification, expectedWriterEpoch: 2 }),
      ),
    ).rejects.toThrow('STALE_AUTHORITY');
    await expect(
      readIdentityAuthority(environment.database, {
        ...qualification,
        expectedNormalizerVersion: 'unreviewed-normalizer',
      }),
    ).rejects.toThrow('STALE_AUTHORITY');
  });
});
