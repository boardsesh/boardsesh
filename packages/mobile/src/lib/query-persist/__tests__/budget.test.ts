import { describe, it, expect } from 'vitest';
import { applyBudget, PERSIST_MAX_BYTES, PERSIST_MAX_ENTRY_BYTES, type BudgetCandidate } from '../budget';
import { PERSISTED_QUERY_RULES } from '../allowlist';
import type { PersistedQueryEntry } from '../envelope';

function entry(queryKey: readonly unknown[], payloadBytes: number, dataUpdatedAt = 1000): PersistedQueryEntry {
  return {
    queryHash: JSON.stringify(queryKey),
    queryKey: queryKey as unknown[],
    state: {
      data: 'x'.repeat(payloadBytes),
      dataUpdateCount: 1,
      dataUpdatedAt,
      error: null,
      errorUpdateCount: 0,
      errorUpdatedAt: 0,
      fetchFailureCount: 0,
      fetchFailureReason: null,
      fetchMeta: null,
      isInvalidated: false,
      status: 'success',
      fetchStatus: 'idle',
    },
  } as unknown as PersistedQueryEntry;
}

function priorityOf(head: string): number {
  const rule = PERSISTED_QUERY_RULES.find((candidate) => candidate.head === head);
  if (!rule) throw new Error(`no rule for ${head}`);
  return rule.priority;
}

function candidate(head: string, queryKey: readonly unknown[], payloadBytes: number, at = 1000): BudgetCandidate {
  return { entry: entry(queryKey, payloadBytes, at), priority: priorityOf(head) };
}

describe('applyBudget', () => {
  // T-07 (first half)
  it('drops any single entry over the 64 KB per-entry cap', () => {
    const result = applyBudget([
      candidate('profile', ['profile'], 200),
      candidate('myBoards', ['myBoards', undefined], 70 * 1024),
    ]);

    expect(result.droppedOversize).toBe(1);
    expect(result.droppedEvicted).toBe(0);
    expect(result.kept.map((kept) => kept.queryKey[0])).toEqual(['profile']);
    expect(result.bytes).toBeLessThan(PERSIST_MAX_ENTRY_BYTES);
  });

  // T-07 (second half): lowest priority evicts first, and `['profile']` — the
  // entry the whole feature exists for — is the last thing standing.
  it('evicts lowest-priority-first until the 512 KB cap fits, keeping profile', () => {
    const payload = 60 * 1024;
    const candidates: BudgetCandidate[] = [
      candidate('profile', ['profile'], payload),
      candidate('myBoards', ['myBoards', undefined], payload),
      candidate('myBoards', ['myBoards', { boardType: 'kilter' }], payload),
      candidate('myGyms', ['myGyms'], payload),
      candidate('grades', ['grades', 'kilter'], payload),
      candidate('grades', ['grades', 'tension'], payload),
      candidate('angles', ['angles', 'kilter', 8], payload),
      candidate('angles', ['angles', 'tension', 10], payload),
      candidate('publicProfile', ['publicProfile', 'user-1'], payload),
      candidate('publicProfile', ['publicProfile', 'user-1', 'variant'], payload),
    ];

    const result = applyBudget(candidates);

    expect(result.bytes).toBeLessThanOrEqual(PERSIST_MAX_BYTES);
    expect(result.droppedOversize).toBe(0);
    expect(result.droppedEvicted).toBeGreaterThan(0);

    const keptHashes = new Set(result.kept.map((kept) => kept.queryHash));
    const keptPriorities = candidates.filter((one) => keptHashes.has(one.entry.queryHash)).map((one) => one.priority);
    const evictedPriorities = candidates
      .filter((one) => !keptHashes.has(one.entry.queryHash))
      .map((one) => one.priority);
    // Everything evicted ranks at or below everything kept.
    expect(Math.max(...evictedPriorities)).toBeLessThanOrEqual(Math.min(...keptPriorities));
    // publicProfile is the lowest rule, so it goes first; profile never goes.
    expect(result.kept.some((kept) => kept.queryKey[0] === 'publicProfile')).toBe(false);
    expect(result.kept.some((kept) => kept.queryKey[0] === 'profile')).toBe(true);
  });

  it('evicts the older entry first within one priority', () => {
    const payload = 60 * 1024;
    const candidates: BudgetCandidate[] = [
      candidate('profile', ['profile'], payload),
      ...Array.from({ length: 8 }, (_unused, index) =>
        candidate('grades', ['grades', `board-${index}`], payload, 5000 + index),
      ),
      candidate('grades', ['grades', 'oldest'], payload, 1),
    ];

    const result = applyBudget(candidates);
    expect(result.kept.some((kept) => kept.queryKey[1] === 'oldest')).toBe(false);
  });

  it('reports two empty-array bytes for an empty candidate set', () => {
    expect(applyBudget([])).toEqual({ kept: [], droppedOversize: 0, droppedEvicted: 0, bytes: 2 });
  });
});
