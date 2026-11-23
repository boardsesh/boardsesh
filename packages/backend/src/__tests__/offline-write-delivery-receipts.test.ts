import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { offlineWriteDeliveries, users } from '@boardsesh/db/schema';
import type { OfflineWriteObservation } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import {
  offlineWriteBindingHash,
  recordOfflineWriteObservation,
  recordOfflineWriteVerdict,
} from '../services/offline-write-delivery';

const owner = `delivery-${randomUUID()}`;
const otherOwner = `delivery-${randomUUID()}`;
const started = new Date('2026-11-21T12:00:00.000Z');
const accepted = new Date('2026-11-21T12:00:01.000Z');
const reconciled = new Date('2026-11-21T12:00:02.000Z');
const bindingHash = offlineWriteBindingHash('saveTick', { input: { uuid: 'tick' } });

const pending = (): OfflineWriteObservation => ({
  deliveryId: randomUUID(),
  tableName: 'boardsesh_ticks',
  operation: 'create',
  queuedAt: '2026-11-20T12:00:00.000Z',
  connectivityReason: 'device_offline',
  originRelease: {
    applicationId: 'com.boardsesh.app',
    platform: 'android',
    appVersion: '2.7.0',
    runtimeVersion: 'runtime',
    updateId: null,
    isEmbedded: true,
    branch: 'production',
  },
  state: 'pending',
  observedAt: started.toISOString(),
  revision: 1,
  recovered: false,
  serverResponseAt: null,
  reconciledAt: null,
  firstDeadLetterAt: null,
  lastDeadLetterAt: null,
});

describe('durable private receipt reconciliation', () => {
  beforeAll(async () => {
    await db.insert(users).values([
      { id: owner, email: `${owner}@example.com`, name: 'Delivery fixture' },
      { id: otherOwner, email: `${otherOwner}@example.com`, name: 'Other fixture' },
    ]);
  });
  afterAll(async () => {
    await db.delete(users).where(inArray(users.id, [owner, otherOwner]));
  });

  it('deduplicates uploads and replay receipts without regressing reconciliation', async () => {
    const original = pending();
    await recordOfflineWriteObservation(owner, original, started);
    const verdict = {
      userId: owner,
      deliveryId: original.deliveryId,
      operation: 'saveTick' as const,
      bindingHash,
      accepted: true,
    };
    await recordOfflineWriteVerdict(verdict, accepted);
    await recordOfflineWriteVerdict(verdict, reconciled);
    const complete = {
      ...original,
      revision: 2,
      state: 'reconciled' as const,
      observedAt: reconciled.toISOString(),
      reconciledAt: reconciled.toISOString(),
    };
    expect(await recordOfflineWriteObservation(owner, complete, reconciled)).toEqual({
      deliveryId: original.deliveryId,
      revision: 2,
      serverAcceptedAt: accepted.toISOString(),
      serverRejectedAt: null,
    });
    expect((await recordOfflineWriteObservation(owner, original, reconciled))?.revision).toBe(1);
    const rows = await db
      .select()
      .from(offlineWriteDeliveries)
      .where(and(eq(offlineWriteDeliveries.userId, owner), eq(offlineWriteDeliveries.deliveryId, original.deliveryId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clientState: 'reconciled',
      clientRevision: 2,
      serverAcceptedAt: accepted,
      reconciledReportedAt: reconciled,
    });
  });

  it('keeps an acceptance that reached the server before journal registration', async () => {
    const observation = pending();
    await recordOfflineWriteVerdict(
      { userId: owner, deliveryId: observation.deliveryId, operation: 'saveTick', bindingHash, accepted: true },
      accepted,
    );
    const receipt = await recordOfflineWriteObservation(owner, observation, reconciled);
    expect(receipt?.serverAcceptedAt).toBe(accepted.toISOString());
  });

  it('isolates owners and rejects mutation identity or origin reuse', async () => {
    const observation = pending();
    await recordOfflineWriteObservation(owner, observation, started);
    await recordOfflineWriteVerdict(
      { userId: owner, deliveryId: observation.deliveryId, operation: 'saveTick', bindingHash, accepted: true },
      accepted,
    );
    expect((await recordOfflineWriteObservation(otherOwner, observation, started))?.serverAcceptedAt).toBeNull();
    expect(
      await recordOfflineWriteObservation(
        owner,
        { ...observation, revision: 2, connectivityReason: 'online' },
        reconciled,
      ),
    ).toBeNull();
    expect(
      await recordOfflineWriteObservation(
        owner,
        { ...observation, revision: 2, tableName: 'user_favorites' },
        reconciled,
      ),
    ).toBeNull();
  });

  it('preserves an earlier rejection when an idempotent recovery later succeeds', async () => {
    const observation = pending();
    await recordOfflineWriteObservation(owner, observation, started);
    const verdict = { userId: owner, deliveryId: observation.deliveryId, operation: 'saveTick' as const, bindingHash };
    await recordOfflineWriteVerdict({ ...verdict, accepted: false, rejectionCode: 'CLIMB_NOT_FOUND' }, started);
    await recordOfflineWriteVerdict({ ...verdict, accepted: true }, accepted);
    const receipt = await recordOfflineWriteObservation(
      owner,
      { ...observation, revision: 2, recovered: true },
      reconciled,
    );
    expect(receipt).toMatchObject({
      serverAcceptedAt: accepted.toISOString(),
      serverRejectedAt: started.toISOString(),
    });
  });

  it('does not let a reused delivery ID establish acceptance for a different operation payload', async () => {
    const observation = pending();
    await recordOfflineWriteObservation(owner, observation, started);
    const base = { userId: owner, deliveryId: observation.deliveryId, operation: 'saveTick' as const, bindingHash };
    await recordOfflineWriteVerdict({ ...base, accepted: false, rejectionCode: 'CLIMB_NOT_FOUND' }, started);
    await recordOfflineWriteVerdict({ ...base, bindingHash: 'different-payload', accepted: true }, accepted);
    expect((await recordOfflineWriteObservation(owner, observation, reconciled))?.serverAcceptedAt).toBeNull();
  });

  it('retains rejection and acceptance replay runtimes independently of reporting', async () => {
    const observation = pending();
    await recordOfflineWriteObservation(owner, observation, started);
    const rejectionRelease = { ...observation.originRelease, updateId: 'preview-rejection', branch: 'pr-123' };
    const receivingRelease = { ...observation.originRelease, updateId: 'production-replay' };
    const base = { userId: owner, deliveryId: observation.deliveryId, operation: 'saveTick' as const, bindingHash };
    await recordOfflineWriteVerdict(
      { ...base, accepted: false, rejectionCode: 'CLIMB_NOT_FOUND', receivingRelease: rejectionRelease },
      started,
    );
    await recordOfflineWriteVerdict({ ...base, accepted: true, receivingRelease }, accepted);
    await recordOfflineWriteVerdict(
      { ...base, accepted: true, receivingRelease: { ...receivingRelease, updateId: 'later-replay' } },
      reconciled,
    );
    await recordOfflineWriteObservation(
      owner,
      { ...observation, revision: 2, observedRelease: { ...receivingRelease, updateId: 'reporting-bundle' } },
      reconciled,
    );
    const [stored] = await db
      .select()
      .from(offlineWriteDeliveries)
      .where(
        and(eq(offlineWriteDeliveries.userId, owner), eq(offlineWriteDeliveries.deliveryId, observation.deliveryId)),
      );
    expect(stored?.rejectionRelease).toEqual(rejectionRelease);
    expect(stored?.receivingRelease).toEqual(receivingRelease);
    expect(stored?.observedRelease?.updateId).toBe('reporting-bundle');
  });

  it('runs the exact aggregate report with shared exclusions, follow-up and coverage boundaries', async () => {
    const base = {
      userId: owner,
      tableName: 'boardsesh_ticks',
      operation: 'create',
      queuedAt: new Date('2026-11-09T12:00:00Z'),
      connectivityReason: 'device_offline',
      originRelease: pending().originRelease,
      firstSeenAt: new Date('2026-11-10T00:00:00Z'),
      clientState: 'pending',
      clientObservedAt: new Date('2026-11-20T23:00:00Z'),
      lastReportedAt: new Date('2026-11-20T23:00:00Z'),
    };
    await db.insert(offlineWriteDeliveries).values([
      {
        ...base,
        deliveryId: randomUUID(),
        clientState: 'reconciled',
        recovered: true,
        serverAcceptedAt: new Date('2026-11-10T01:00:00Z'),
        reconciledReportedAt: new Date('2026-11-10T02:00:00Z'),
      },
      {
        ...base,
        deliveryId: randomUUID(),
        clientState: 'reconciled',
        serverAcceptedAt: new Date('2026-11-10T01:00:00Z'),
        reconciledReportedAt: new Date('2026-11-18T00:00:00Z'),
      },
      { ...base, deliveryId: randomUUID(), recovered: true },
      {
        ...base,
        deliveryId: randomUUID(),
        originRelease: { ...base.originRelease, applicationId: 'com.boardsesh.app.dev', branch: null },
      },
      { ...base, deliveryId: randomUUID(), originRelease: { ...base.originRelease, applicationId: null } },
      {
        ...base,
        deliveryId: randomUUID(),
        receivingRelease: { ...base.originRelease, applicationId: 'com.boardsesh.app.dev', branch: null },
        serverAcceptedAt: new Date('2026-11-10T01:00:00Z'),
      },
      {
        ...base,
        deliveryId: randomUUID(),
        clientObservedAt: new Date('2026-11-18T00:00:00Z'),
        lastReportedAt: new Date('2026-11-18T00:00:00Z'),
      },
      {
        ...base,
        deliveryId: randomUUID(),
        clientState: 'dead_letter',
        serverRejectedAt: new Date('2026-11-11T00:00:00Z'),
      },
      { ...base, deliveryId: randomUUID(), firstSeenAt: new Date('2026-11-20T12:00:00Z') },
      {
        ...base,
        deliveryId: randomUUID(),
        firstSeenAt: new Date('2026-11-20T12:00:00Z'),
        clientState: 'dead_letter',
        serverRejectedAt: new Date('2026-11-20T13:00:00Z'),
      },
      { ...base, deliveryId: randomUUID(), queuedAt: null, serverAcceptedAt: new Date('2026-11-10T01:00:00Z') },
      {
        ...base,
        deliveryId: randomUUID(),
        userId: otherOwner,
        queuedAt: null,
        serverAcceptedAt: new Date('2026-11-10T01:00:00Z'),
      },
      {
        ...base,
        deliveryId: randomUUID(),
        queuedAt: null,
        serverAcceptedAt: new Date('2026-11-25T00:00:00Z'),
        firstSeenAt: new Date('2026-11-25T00:00:00Z'),
      },
      {
        ...base,
        deliveryId: randomUUID(),
        clientState: 'dead_letter',
        serverRejectedAt: new Date('2026-11-11T00:00:00Z'),
        rejectionRelease: { ...base.originRelease, branch: 'pr-123' },
      },
    ]);
    const reportSql = readFileSync(new URL('../../scripts/offline-write-delivery-report.sql', import.meta.url), 'utf8')
      .replace(
        "TIMESTAMPTZ '2026-11-21 00:00:00+00' AS cohort_end",
        "TIMESTAMPTZ '2026-12-01 00:00:00+00' AS cohort_end",
      )
      .replace('ARRAY[]::text[] AS excluded_user_ids', `ARRAY['${otherOwner}']::text[] AS excluded_user_ids`);
    type ReportResult = {
      outcome: string;
      follow_up: string;
      writes: number;
      recovered: number;
      recovery_history: number;
      server_rejected: number;
    };
    const [row] = (await db.execute(sql.raw(reportSql))) as unknown as Array<{
      report: {
        parameters: Record<string, unknown>;
        results: ReportResult[];
        coverage: {
          acceptance_without_enqueue: number;
          rejection_without_enqueue: number;
          enqueue_application_unknown: number;
          excluded_application_namespace: number;
        }[];
      };
    }>;
    const mature = row!.report.results.filter((result) => result.follow_up === '7 days');
    expect(Object.fromEntries(mature.map((result) => [result.outcome, result.writes]))).toEqual({
      success: 1,
      late: 1,
      pending: 1,
      unknown: 1,
      rejected: 1,
      age_censored: 2,
    });
    expect(mature.find((result) => result.outcome === 'pending')).toMatchObject({ recovered: 0, recovery_history: 1 });
    expect(mature.find((result) => result.outcome === 'success')).toMatchObject({ recovered: 1 });
    expect(mature.find((result) => result.outcome === 'age_censored')).toMatchObject({ server_rejected: 1 });
    expect(row!.report.coverage).toMatchObject([
      {
        acceptance_without_enqueue: 1,
        rejection_without_enqueue: 0,
        enqueue_application_unknown: 1,
        excluded_application_namespace: 2,
      },
    ]);
    expect(row!.report.parameters).not.toHaveProperty('excluded_user_ids');
    expect(JSON.stringify(row!.report)).not.toMatch(new RegExp(`${owner}|${otherOwner}`));
  });

  it('erases private receipts with their account without changing another owner', async () => {
    const erasedOwner = `delivery-erasure-${randomUUID()}`;
    await db.insert(users).values({ id: erasedOwner, email: `${erasedOwner}@example.com`, name: 'Erasure fixture' });
    const observation = pending();
    await recordOfflineWriteObservation(erasedOwner, observation, started);
    await recordOfflineWriteObservation(owner, observation, started);
    await db.delete(users).where(eq(users.id, erasedOwner));
    const remaining = await db
      .select({ userId: offlineWriteDeliveries.userId })
      .from(offlineWriteDeliveries)
      .where(eq(offlineWriteDeliveries.deliveryId, observation.deliveryId));
    expect(remaining).toEqual([{ userId: owner }]);
  });
});
