import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  generation: 1,
  owner: 'source',
  completed: null as string | null,
  journal: null as string | null,
  pending: 2,
  events: [] as string[],
}));
vi.mock('@boardsesh/offline-sync', () => ({
  beginGlobalPurge: () => state.events.push('fence'),
  setSigningOut: (paused: boolean) => state.events.push(paused ? 'pause' : 'resume'),
}));
vi.mock('../../db', () => {
  const transaction = {
    getFirstAsync: async (query: string, parameters?: string[]) => {
      if (query.includes('COUNT')) return { count: state.pending };
      const key = parameters?.[0];
      const value =
        key === 'local_user_id'
          ? state.owner
          : key === 'account_consolidation_completed'
            ? state.completed
            : state.journal;
      return value === null ? null : { value };
    },
    runAsync: async (_query: string, parameters: string[]) => {
      state.journal = parameters[1];
      state.events.push('journal');
    },
  };
  return {
    getDatabaseHandle: () => ({
      ...transaction,
      withExclusiveTransactionAsync: async (callback: (database: typeof transaction) => Promise<void>) =>
        callback(transaction),
    }),
    clearUserData: async (_database: unknown, options: { completedMergeId: string; isCurrent(): boolean }) => {
      expect(options.isCurrent()).toBe(true);
      state.events.push('local-transaction');
      state.owner = 'target';
      state.completed = options.completedMergeId;
      state.journal = null;
    },
  };
});
import { reconcileBrowserAccountConsolidation } from '../account-consolidation-client.web';
const receipt = { mergeId: 'merge', fromUserId: 'source', toUserId: 'target' };
const epochs = {
  isCurrent: (generation: number) => generation === state.generation,
  advanceEpoch: (generation: number) => (generation === state.generation ? ++state.generation : null),
};
beforeEach(() => {
  state.generation = 1;
  state.owner = 'source';
  state.completed = null;
  state.journal = null;
  state.pending = 2;
  state.events = [];
});
describe('browser consolidation local ownership', () => {
  it('journals receipt without credentials and commits ownership while preserving queued mutations', async () => {
    expect(await reconcileBrowserAccountConsolidation(receipt, 1, epochs)).toBe(2);
    expect(state.owner).toBe('target');
    expect(state.completed).toBe('merge');
    expect(state.pending).toBe(2);
    expect(state.events).toEqual(['fence', 'pause', 'journal', 'journal', 'journal', 'local-transaction', 'resume']);
  });
  it('does not reset caches a second time for the same completed merge', async () => {
    state.owner = 'target';
    state.completed = 'merge';
    expect(await reconcileBrowserAccountConsolidation(receipt, 1, epochs)).toBe(1);
    expect(state.events).toEqual([]);
  });
  it('refuses to transfer another account or an unstamped queue', async () => {
    state.owner = 'other';
    await expect(reconcileBrowserAccountConsolidation(receipt, 1, epochs)).rejects.toThrow('local owner mismatch');
    expect(state.events).toEqual([]);
  });
});
