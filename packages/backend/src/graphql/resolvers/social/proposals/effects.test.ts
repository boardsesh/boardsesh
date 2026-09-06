import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import * as dbSchema from '@boardsesh/db/schema';

/**
 * Unit coverage for the `hide` branches of the proposal effect.
 *
 * These two are the only effects that write to `board_climbs` rather than a
 * status side-table, so what matters is the table they target and the exact
 * column pair they set: `is_hidden` together with `hidden_at`, never one
 * without the other, and never `updated_at` (a BEFORE UPDATE trigger owns it).
 * A mocked db keeps that assertion about the write itself; the end-to-end path
 * is covered against a real database in report-climb-integration.test.ts.
 */

type UpdateCall = { table: unknown; values: Record<string, unknown> };

const { mockDb, updateCalls, queueSelectRows } = vi.hoisted(() => {
  const updateCalls: UpdateCall[] = [];
  const selectQueue: unknown[][] = [];

  const queueSelectRows = (rows: unknown[]) => selectQueue.push(rows);

  const selectChain = () => {
    const rows = selectQueue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'orderBy', 'limit', 'leftJoin', 'groupBy']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
    return chain;
  };

  const mockDb = {
    select: vi.fn(() => selectChain()),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updateCalls.push({ table, values });
        return { where: vi.fn(() => Promise.resolve(undefined)) };
      }),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve(undefined)) })),
  };

  return { mockDb, updateCalls, queueSelectRows };
});

vi.mock('../../../../db/client', () => ({ db: mockDb }));

import { applyProposalEffect, revertProposalEffect } from './effects';

type ProposalRow = typeof dbSchema.climbProposals.$inferSelect;

function hideProposal(overrides: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: 7,
    uuid: 'proposal-uuid',
    climbUuid: 'climb-uuid',
    boardType: 'kilter',
    angle: null,
    proposerId: 'user-1',
    type: 'hide',
    proposedValue: 'true',
    currentValue: 'false',
    status: 'approved',
    reason: null,
    resolvedAt: new Date('2026-03-01T00:00:00.000Z'),
    resolvedBy: null,
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    ...overrides,
  } as ProposalRow;
}

describe('applyProposalEffect — hide', () => {
  beforeEach(() => {
    updateCalls.length = 0;
    mockDb.select.mockClear();
    mockDb.update.mockClear();
  });

  it('hides the climb and stamps hidden_at', async () => {
    await applyProposalEffect(hideProposal({ proposedValue: 'true' }));

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].table).toBe(dbSchema.boardClimbs);
    expect(updateCalls[0].values.isHidden).toBe(true);
    expect(updateCalls[0].values.hiddenAt).toBeInstanceOf(Date);
  });

  it('unhides the climb and clears hidden_at', async () => {
    await applyProposalEffect(hideProposal({ proposedValue: 'false', currentValue: 'true' }));

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].values.isHidden).toBe(false);
    expect(updateCalls[0].values.hiddenAt).toBeNull();
  });

  it('leaves updated_at to the database trigger', async () => {
    await applyProposalEffect(hideProposal());

    expect(Object.keys(updateCalls[0].values).sort()).toEqual(['hiddenAt', 'isHidden']);
  });

  it('touches no status side-table', async () => {
    await applyProposalEffect(hideProposal());

    expect(mockDb.select).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

describe('revertProposalEffect — hide', () => {
  beforeEach(() => {
    updateCalls.length = 0;
    mockDb.select.mockClear();
    mockDb.update.mockClear();
  });

  it('makes the climb visible again when no earlier hide decision survives', async () => {
    queueSelectRows([]);

    await revertProposalEffect(hideProposal());

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].table).toBe(dbSchema.boardClimbs);
    expect(updateCalls[0].values.isHidden).toBe(false);
    expect(updateCalls[0].values.hiddenAt).toBeNull();
  });

  it('falls back to the previous approved hide decision', async () => {
    const previousResolvedAt = new Date('2026-01-15T00:00:00.000Z');
    queueSelectRows([hideProposal({ id: 3, proposedValue: 'true', resolvedAt: previousResolvedAt })]);

    await revertProposalEffect(hideProposal({ id: 9, proposedValue: 'false' }));

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].values.isHidden).toBe(true);
    expect(updateCalls[0].values.hiddenAt).toEqual(previousResolvedAt);
  });

  it('stays hidden-free when the previous decision was an unhide', async () => {
    queueSelectRows([hideProposal({ id: 3, proposedValue: 'false' })]);

    await revertProposalEffect(hideProposal({ id: 9 }));

    expect(updateCalls[0].values.isHidden).toBe(false);
    expect(updateCalls[0].values.hiddenAt).toBeNull();
  });
});
