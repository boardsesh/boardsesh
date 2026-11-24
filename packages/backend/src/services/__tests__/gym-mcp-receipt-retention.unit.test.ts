import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { gymMcpWriteReceipts } from '@boardsesh/db/schema/auth';
import type { Database } from '../../db/client';
import { sweepGymMcpReceiptPayloads } from '../gym-mcp-receipt-retention';

// This isolated suite never imports the real client or opens a database pool.
vi.mock('../../db/client', () => ({ db: {} }));

type Receipt = typeof gymMcpWriteReceipts.$inferSelect;
const now = new Date('2026-11-24T12:00:00Z');

function receipt(index: number): Receipt {
  return {
    userId: `owner-${index}`,
    clientId: 'https://assistant.example/client.json',
    connectionGeneration: 3,
    idempotencyKey: `retry-${index}`,
    operationName: 'update_gym',
    inputHash: `input-${index}`,
    result: { name: `Gym ${index}` },
    createdAt: new Date('2026-11-16T12:00:00Z'),
    expiresAt: new Date('2026-11-23T12:00:00Z'),
  };
}

function receiptDatabase(rows: Receipt[]) {
  const control = { failTransaction: 0, readGate: undefined as Promise<void> | undefined };
  const selectedBatchSizes: number[] = [];
  const patches: unknown[] = [];
  const selectionQueries: SQL[] = [];
  const lockOptions: unknown[] = [];
  const transaction = vi.fn(async (work: (executor: unknown) => Promise<number>) => {
    const transactionNumber = transaction.mock.calls.length;
    let selected: Receipt[] = [];
    let batchLimit = 0;
    let updateRequested = false;
    const selection = {
      from: () => selection,
      where: (condition: SQL) => {
        selectionQueries.push(condition);
        return selection;
      },
      orderBy: () => selection,
      limit: (limit: number) => {
        batchLimit = limit;
        return selection;
      },
      for: async (strength: string, options: unknown) => {
        lockOptions.push({ strength, options });
        await control.readGate;
        selected = rows.filter((row) => row.expiresAt <= now && row.result !== null).slice(0, batchLimit);
        selectedBatchSizes.push(selected.length);
        return selected;
      },
    };
    const executor = {
      execute: vi.fn(),
      select: () => selection,
      update: () => ({
        set: (patch: unknown) => ({
          where: async () => {
            patches.push(patch);
            if (control.failTransaction === transactionNumber) throw new Error('Database write failed');
            updateRequested = true;
          },
        }),
      }),
    };
    const cleared = await work(executor);
    // Commit this batch only after its callback succeeds. Failed later batches
    // leave earlier commits intact, just as separate PostgreSQL transactions do.
    if (updateRequested) for (const selectedReceipt of selected) selectedReceipt.result = null;
    return cleared;
  });
  return {
    database: { transaction } as unknown as Database,
    control,
    transaction,
    selectedBatchSizes,
    patches,
    selectionQueries,
    lockOptions,
  };
}

describe('gym MCP receipt payload retention', () => {
  it('drains more than two full batches without deleting retry identities', async () => {
    const rows = Array.from({ length: 2507 }, (_, index) => receipt(index));
    const originals = structuredClone(rows);
    const storage = receiptDatabase(rows);

    expect(await sweepGymMcpReceiptPayloads(storage.database, now)).toBe(2507);

    expect(storage.selectedBatchSizes).toEqual([1000, 1000, 507]);
    expect(storage.transaction).toHaveBeenCalledTimes(3);
    expect(storage.patches).toEqual([{ result: null }, { result: null }, { result: null }]);
    for (const [index, storedReceipt] of rows.entries()) {
      expect(storedReceipt).toEqual({ ...originals[index], result: null });
    }
    expect(storage.lockOptions).toEqual(
      Array.from({ length: 3 }, () => ({ strength: 'update', options: { skipLocked: true } })),
    );
    const dialect = new PgDialect();
    for (const condition of storage.selectionQueries) {
      const query = dialect.sqlToQuery(condition);
      expect(query.sql).toContain('"expires_at" <=');
      expect(query.sql).toContain('"result" is not null');
      expect(query.params).toEqual([now.toISOString()]);
    }
  });

  it('preserves unexpired payloads and existing tombstones and stops on an empty batch', async () => {
    const unexpired = { ...receipt(1), expiresAt: new Date('2026-11-25T12:00:00Z') };
    const tombstone = { ...receipt(2), result: null };
    const rows = [unexpired, tombstone];
    const originals = structuredClone(rows);
    const storage = receiptDatabase(rows);

    expect(await sweepGymMcpReceiptPayloads(storage.database, now)).toBe(0);
    expect(rows).toEqual(originals);
    expect(storage.selectedBatchSizes).toEqual([0]);
    expect(storage.patches).toEqual([]);
  });

  it('continues after an exactly full final batch until the next read is empty', async () => {
    const storage = receiptDatabase(Array.from({ length: 1000 }, (_, index) => receipt(index)));
    expect(await sweepGymMcpReceiptPayloads(storage.database, now)).toBe(1000);
    expect(storage.selectedBatchSizes).toEqual([1000, 0]);
    expect(storage.patches).toEqual([{ result: null }]);
  });

  it('coalesces overlapping sweeps on the same database handle', async () => {
    const storage = receiptDatabase([receipt(1)]);
    let resume = () => {};
    storage.control.readGate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const firstSweep = sweepGymMcpReceiptPayloads(storage.database, now);
    const overlappingSweep = sweepGymMcpReceiptPayloads(storage.database, now);
    expect(overlappingSweep).toBe(firstSweep);
    expect(storage.transaction).toHaveBeenCalledTimes(1);
    resume();
    expect(await Promise.all([firstSweep, overlappingSweep])).toEqual([1, 1]);
    expect(storage.patches).toEqual([{ result: null }]);
  });

  it('keeps completed batches after an error and permits a later sweep to finish', async () => {
    const rows = Array.from({ length: 1500 }, (_, index) => receipt(index));
    const originals = structuredClone(rows);
    const storage = receiptDatabase(rows);
    storage.control.failTransaction = 2;

    await expect(sweepGymMcpReceiptPayloads(storage.database, now)).rejects.toThrow('Database write failed');
    expect(rows.filter((row) => row.result === null)).toHaveLength(1000);
    expect(rows.slice(1000)).toEqual(originals.slice(1000));

    storage.control.failTransaction = 0;
    expect(await sweepGymMcpReceiptPayloads(storage.database, now)).toBe(500);
    expect(storage.selectedBatchSizes).toEqual([1000, 500, 500]);
    expect(await sweepGymMcpReceiptPayloads(storage.database, now)).toBe(0);
    for (const [index, storedReceipt] of rows.entries()) {
      expect(storedReceipt).toEqual({ ...originals[index], result: null });
    }
  });
});
