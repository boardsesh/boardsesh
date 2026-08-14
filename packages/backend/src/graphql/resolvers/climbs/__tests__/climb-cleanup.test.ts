import { describe, expect, it, vi } from 'vite-plus/test';
import { deleteClimbDependentRows, groupClimbUuidsByBoardType } from '../climb-cleanup';

function makeMockTx() {
  const deleteCalls: Array<{ table: unknown; args: unknown[] }> = [];
  const tx = {
    delete: vi.fn().mockImplementation((table: unknown) => {
      const call = { table, args: [] as unknown[] };
      deleteCalls.push(call);
      return {
        where: vi.fn().mockImplementation((...args: unknown[]) => {
          call.args = args;
          return Promise.resolve(undefined);
        }),
      };
    }),
  };
  return { tx, deleteCalls };
}

describe('deleteClimbDependentRows', () => {
  it('deletes board_climb_stats, board_climb_stats_history, and board_beta_links for the given climbs', async () => {
    const { tx, deleteCalls } = makeMockTx();

    await deleteClimbDependentRows(tx as never, 'kilter', ['climb-1', 'climb-2']);

    expect(deleteCalls).toHaveLength(3);
    // Each delete's WHERE predicate must have been built (not skipped) — a
    // condition arg was passed through for every call.
    for (const call of deleteCalls) {
      expect(call.args).toHaveLength(1);
    }
  });

  it('is a no-op when given no climb uuids', async () => {
    const { tx, deleteCalls } = makeMockTx();

    await deleteClimbDependentRows(tx as never, 'kilter', []);

    expect(tx.delete).not.toHaveBeenCalled();
    expect(deleteCalls).toHaveLength(0);
  });
});

describe('groupClimbUuidsByBoardType', () => {
  it('groups uuids under their board type, preserving per-group order', () => {
    const grouped = groupClimbUuidsByBoardType([
      { boardType: 'kilter', uuid: 'a' },
      { boardType: 'tension', uuid: 'b' },
      { boardType: 'kilter', uuid: 'c' },
    ]);

    expect(Array.from(grouped.entries())).toEqual([
      ['kilter', ['a', 'c']],
      ['tension', ['b']],
    ]);
  });

  it('returns an empty map for an empty input', () => {
    const grouped = groupClimbUuidsByBoardType([]);

    expect(grouped.size).toBe(0);
  });
});
