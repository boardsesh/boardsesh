import { describe, it, expect } from 'vitest';
import type {
  BoardConnectionHolder,
  BoardPresenceClimb,
  BoardPresenceEvent,
  BoardPresenceStats,
} from '@boardsesh/shared-schema';
import { boardPresenceReducer, initialBoardPresenceState, HISTORY_CAP } from '../reducer';
import { mapBoardPresenceEnvelopeToAction } from '../map-envelope';
import type { BoardPresenceState } from '../types';

function makeClimb(overrides: Partial<BoardPresenceClimb> & { seq: number }): BoardPresenceClimb {
  return {
    climbUuid: overrides.climbUuid ?? `climb-${overrides.seq}`,
    name: overrides.name ?? `Climb ${overrides.seq}`,
    grade: overrides.grade ?? 'V5',
    sentAt: overrides.sentAt ?? `2026-06-09T00:00:0${overrides.seq % 10}.000Z`,
    ...overrides,
  };
}

function makeState(overrides: Partial<BoardPresenceState> = {}): BoardPresenceState {
  return {
    ...initialBoardPresenceState,
    ...overrides,
  };
}

function makeStats(overrides: Partial<BoardPresenceStats> = {}): BoardPresenceStats {
  return {
    climbsSentCount: 0,
    distinctClimbersCount: 0,
    hardestGrade: null,
    topGrade: null,
    lastSentAt: null,
    ...overrides,
  };
}

function makeHolder(overrides: Partial<BoardConnectionHolder> = {}): BoardConnectionHolder {
  return {
    userId: 'user-1',
    displayName: 'Climber',
    avatarUrl: null,
    lastSentAt: null,
    ...overrides,
  };
}

describe('initialBoardPresenceState', () => {
  it('starts empty with seq 0', () => {
    expect(initialBoardPresenceState).toEqual({
      currentClimb: null,
      previousClimb: null,
      history: [],
      lastSeq: 0,
      stats: null,
      lastStatsSeq: 0,
      holder: null,
      lastConnectionSeq: 0,
    });
  });
});

describe('APPLY_CLIMB_SET', () => {
  it('sets current, history and lastSeq in order', () => {
    const first = makeClimb({ seq: 1 });
    const result = boardPresenceReducer(initialBoardPresenceState, {
      type: 'APPLY_CLIMB_SET',
      payload: first,
    });

    expect(result.currentClimb).toEqual(first);
    expect(result.previousClimb).toBeNull();
    expect(result.history).toEqual([first]);
    expect(result.lastSeq).toBe(1);
  });

  it('stashes the prior current as previousClimb (for Undo) and prepends history newest-first', () => {
    const first = makeClimb({ seq: 1 });
    const second = makeClimb({ seq: 2 });

    const afterFirst = boardPresenceReducer(initialBoardPresenceState, {
      type: 'APPLY_CLIMB_SET',
      payload: first,
    });
    const afterSecond = boardPresenceReducer(afterFirst, { type: 'APPLY_CLIMB_SET', payload: second });

    expect(afterSecond.currentClimb).toEqual(second);
    expect(afterSecond.previousClimb).toEqual(first);
    expect(afterSecond.history).toEqual([second, first]);
    expect(afterSecond.lastSeq).toBe(2);
  });

  it('merges an older out-of-order live set into history without regressing the wall', () => {
    const current = makeClimb({ seq: 5 });
    const state = makeState({ currentClimb: current, history: [current], lastSeq: 5 });

    const stale = makeClimb({ seq: 3 });
    const result = boardPresenceReducer(state, { type: 'APPLY_CLIMB_SET', payload: stale });

    expect(result.currentClimb).toEqual(current);
    expect(result.previousClimb).toBeNull();
    expect(result.lastSeq).toBe(5);
    expect(result.history.map((climb) => climb.seq)).toEqual([5, 3]);
  });

  it('ignores an exact duplicate (climbUuid, seq) so backfill + live stream do not double-apply', () => {
    // lastSeq has been advanced past by a CLEARED, but the same set is replayed.
    const climb = makeClimb({ climbUuid: 'dup', seq: 4 });
    const state = makeState({ history: [climb], lastSeq: 4 });

    const result = boardPresenceReducer(state, { type: 'APPLY_CLIMB_SET', payload: climb });
    expect(result).toBe(state);
  });

  it('applies a re-send of the same climbUuid when the server assigns a new seq', () => {
    const firstSend = makeClimb({ climbUuid: 'project', seq: 4 });
    const afterFirst = boardPresenceReducer(initialBoardPresenceState, {
      type: 'APPLY_CLIMB_SET',
      payload: firstSend,
    });
    const secondSend = makeClimb({ climbUuid: 'project', seq: 5 });
    const afterSecond = boardPresenceReducer(afterFirst, {
      type: 'APPLY_CLIMB_SET',
      payload: secondSend,
    });

    expect(afterSecond.currentClimb).toEqual(secondSend);
    expect(afterSecond.previousClimb).toEqual(firstSend);
    expect(afterSecond.history.map((entry) => entry.seq)).toEqual([5, 4]);
  });

  it('caps history at HISTORY_CAP newest-first', () => {
    let state = initialBoardPresenceState;
    for (let seq = 1; seq <= HISTORY_CAP + 10; seq += 1) {
      state = boardPresenceReducer(state, { type: 'APPLY_CLIMB_SET', payload: makeClimb({ seq }) });
    }

    expect(state.history).toHaveLength(HISTORY_CAP);
    expect(state.history[0].seq).toBe(HISTORY_CAP + 10);
    expect(state.history[HISTORY_CAP - 1].seq).toBe(11);
    expect(state.lastSeq).toBe(HISTORY_CAP + 10);
  });
});

describe('APPLY_CLIMB_CLEARED', () => {
  it('clears current and stashes previousClimb when newer than lastSeq', () => {
    const current = makeClimb({ seq: 7 });
    const state = makeState({ currentClimb: current, history: [current], lastSeq: 7 });

    const result = boardPresenceReducer(state, {
      type: 'APPLY_CLIMB_CLEARED',
      payload: { clearedAt: '2026-06-09T01:00:00.000Z', seq: 8 },
    });

    expect(result.currentClimb).toBeNull();
    expect(result.previousClimb).toEqual(current);
    expect(result.lastSeq).toBe(8);
    // Cleared is not pushed to history.
    expect(result.history).toEqual([current]);
  });

  it('ignores a stale clear (seq <= lastSeq) so it cannot wipe a newer set', () => {
    const current = makeClimb({ seq: 10 });
    const state = makeState({ currentClimb: current, history: [current], lastSeq: 10 });

    const result = boardPresenceReducer(state, {
      type: 'APPLY_CLIMB_CLEARED',
      payload: { clearedAt: '2026-06-09T01:00:00.000Z', seq: 9 },
    });

    expect(result).toBe(state);
  });
});

describe('BACKFILL_HISTORY', () => {
  it('merges newest-first, dedups by (climbUuid, seq) and sets lastSeq to the max', () => {
    const existing = makeClimb({ seq: 2 });
    const state = makeState({ currentClimb: existing, history: [existing], lastSeq: 2 });

    const backfill = [makeClimb({ seq: 1 }), existing, makeClimb({ seq: 3 })];
    const result = boardPresenceReducer(state, { type: 'BACKFILL_HISTORY', payload: backfill });

    expect(result.history.map((climb) => climb.seq)).toEqual([3, 2, 1]);
    expect(result.lastSeq).toBe(3);
    // Newest backfilled climb (seq 3) is adopted as current since it's newer.
    expect(result.currentClimb?.seq).toBe(3);
    expect(result.previousClimb).toEqual(existing);
  });

  it('is idempotent — replaying the same backfill twice yields the same state', () => {
    const backfill = [makeClimb({ seq: 1 }), makeClimb({ seq: 2 }), makeClimb({ seq: 3 })];

    const once = boardPresenceReducer(initialBoardPresenceState, {
      type: 'BACKFILL_HISTORY',
      payload: backfill,
    });
    const twice = boardPresenceReducer(once, { type: 'BACKFILL_HISTORY', payload: backfill });

    expect(twice).toEqual(once);
  });

  it('does NOT clobber a newer live currentClimb already applied', () => {
    const liveCurrent = makeClimb({ seq: 20, climbUuid: 'live' });
    const state = makeState({ currentClimb: liveCurrent, history: [liveCurrent], lastSeq: 20 });

    const backfill = [makeClimb({ seq: 5 }), makeClimb({ seq: 6 })];
    const result = boardPresenceReducer(state, { type: 'BACKFILL_HISTORY', payload: backfill });

    expect(result.currentClimb).toEqual(liveCurrent);
    // lastSeq stays at the live max, not the backfill max.
    expect(result.lastSeq).toBe(20);
    expect(result.history.map((climb) => climb.seq)).toEqual([20, 6, 5]);
  });

  it('adopts the newest history climb as current when there is no live current', () => {
    const backfill = [makeClimb({ seq: 11 }), makeClimb({ seq: 12 })];
    const result = boardPresenceReducer(initialBoardPresenceState, {
      type: 'BACKFILL_HISTORY',
      payload: backfill,
    });

    expect(result.currentClimb?.seq).toBe(12);
  });

  it('does not resurrect a cleared wall from an older backfill', () => {
    const litThenCleared = makeClimb({ seq: 9 });
    let state = boardPresenceReducer(initialBoardPresenceState, {
      type: 'APPLY_CLIMB_SET',
      payload: litThenCleared,
    });
    state = boardPresenceReducer(state, {
      type: 'APPLY_CLIMB_CLEARED',
      payload: { clearedAt: '2026-06-09T01:00:00.000Z', seq: 10 },
    });

    const result = boardPresenceReducer(state, {
      type: 'BACKFILL_HISTORY',
      payload: [litThenCleared],
    });

    expect(result.currentClimb).toBeNull();
    expect(result.previousClimb).toEqual(litThenCleared);
    expect(result.lastSeq).toBe(10);
    expect(result.history).toEqual([litThenCleared]);
  });

  it('no-ops on an empty backfill', () => {
    const state = makeState({ lastSeq: 4 });
    const result = boardPresenceReducer(state, { type: 'BACKFILL_HISTORY', payload: [] });
    expect(result).toBe(state);
  });
});

describe('APPLY_STATS_UPDATED', () => {
  it('applies the live stats push and advances lastStatsSeq', () => {
    const stats = makeStats({ climbsSentCount: 3, distinctClimbersCount: 2, hardestGrade: 'V8' });
    const result = boardPresenceReducer(initialBoardPresenceState, {
      type: 'APPLY_STATS_UPDATED',
      payload: { stats, seq: 7 },
    });

    expect(result.stats).toEqual(stats);
    expect(result.lastStatsSeq).toBe(7);
  });

  it('ignores a stale or duplicate push (seq <= lastStatsSeq) so out-of-order fan-out cannot regress', () => {
    const fresh = makeStats({ climbsSentCount: 5 });
    const state = makeState({ stats: fresh, lastStatsSeq: 10 });

    const stale = boardPresenceReducer(state, {
      type: 'APPLY_STATS_UPDATED',
      payload: { stats: makeStats({ climbsSentCount: 1 }), seq: 9 },
    });
    expect(stale).toBe(state);

    const duplicate = boardPresenceReducer(state, {
      type: 'APPLY_STATS_UPDATED',
      payload: { stats: makeStats({ climbsSentCount: 1 }), seq: 10 },
    });
    expect(duplicate).toBe(state);
  });

  it('does not touch climb-ordering state (lastSeq / currentClimb)', () => {
    const current = makeClimb({ seq: 4 });
    const state = makeState({ currentClimb: current, history: [current], lastSeq: 4 });

    const result = boardPresenceReducer(state, {
      type: 'APPLY_STATS_UPDATED',
      payload: { stats: makeStats({ climbsSentCount: 2 }), seq: 5 },
    });

    expect(result.currentClimb).toEqual(current);
    expect(result.lastSeq).toBe(4);
    expect(result.lastStatsSeq).toBe(5);
  });
});

describe('shared seq counter — climb vs stats cursors are independent', () => {
  // Climb and stats events draw from ONE monotonic per-board counter, but the
  // reducer gates them on two SEPARATE cursors (lastSeq vs lastStatsSeq). A
  // stats push must not be gated against the climb cursor, and vice versa.
  it('applies a stats push whose seq is below lastSeq (the climb cursor must not gate stats)', () => {
    // A climb already advanced the shared counter to 7; the first stats push
    // happens to carry seq 4. It must STILL apply — lastStatsSeq is 0, not 7.
    const current = makeClimb({ seq: 7 });
    const state = makeState({ currentClimb: current, history: [current], lastSeq: 7 });

    const result = boardPresenceReducer(state, {
      type: 'APPLY_STATS_UPDATED',
      payload: { stats: makeStats({ climbsSentCount: 2 }), seq: 4 },
    });

    expect(result.stats?.climbsSentCount).toBe(2);
    expect(result.lastStatsSeq).toBe(4);
    expect(result.lastSeq).toBe(7);
    expect(result.currentClimb).toEqual(current);
  });

  it('still dedups a climb re-delivery against lastSeq after a higher stats seq has landed', () => {
    const climb = makeClimb({ climbUuid: 'dup', seq: 5 });
    let state = boardPresenceReducer(makeState(), { type: 'APPLY_CLIMB_SET', payload: climb });
    // A stats push at seq 6 advances lastStatsSeq but not lastSeq.
    state = boardPresenceReducer(state, {
      type: 'APPLY_STATS_UPDATED',
      payload: { stats: makeStats({ climbsSentCount: 1 }), seq: 6 },
    });
    expect(state.lastSeq).toBe(5);
    expect(state.lastStatsSeq).toBe(6);

    // Re-delivery of the same climb (seq 5) must dedup against lastSeq, wholly
    // unaffected by lastStatsSeq having advanced to 6.
    const afterRedeliver = boardPresenceReducer(state, { type: 'APPLY_CLIMB_SET', payload: climb });
    expect(afterRedeliver).toBe(state);
  });

  it('preserves stats + lastStatsSeq across climb set and clear', () => {
    const stats = makeStats({ climbsSentCount: 3, hardestGrade: 'V7' });
    const base = makeState({ stats, lastStatsSeq: 9 });

    const afterSet = boardPresenceReducer(base, { type: 'APPLY_CLIMB_SET', payload: makeClimb({ seq: 10 }) });
    expect(afterSet.stats).toBe(stats);
    expect(afterSet.lastStatsSeq).toBe(9);

    const afterClear = boardPresenceReducer(afterSet, {
      type: 'APPLY_CLIMB_CLEARED',
      payload: { clearedAt: '2026-06-09T01:00:00.000Z', seq: 11 },
    });
    expect(afterClear.stats).toBe(stats);
    expect(afterClear.lastStatsSeq).toBe(9);
  });
});

describe('SEED_STATS', () => {
  it('fills the tiles when no stats have landed yet, leaving lastStatsSeq at 0 so a live push still wins', () => {
    const seeded = makeStats({ climbsSentCount: 1 });
    const afterSeed = boardPresenceReducer(initialBoardPresenceState, { type: 'SEED_STATS', payload: seeded });
    expect(afterSeed.stats).toEqual(seeded);
    expect(afterSeed.lastStatsSeq).toBe(0);

    // A subsequent live push (any seq > 0) overrides the seed.
    const live = makeStats({ climbsSentCount: 9 });
    const afterLive = boardPresenceReducer(afterSeed, {
      type: 'APPLY_STATS_UPDATED',
      payload: { stats: live, seq: 1 },
    });
    expect(afterLive.stats).toEqual(live);
    expect(afterLive.lastStatsSeq).toBe(1);
  });

  it('is a no-op once any stats are present, so a late cold fetch cannot clobber a fresher live push', () => {
    const live = makeStats({ climbsSentCount: 9 });
    const state = makeState({ stats: live, lastStatsSeq: 3 });

    const result = boardPresenceReducer(state, { type: 'SEED_STATS', payload: makeStats({ climbsSentCount: 1 }) });
    expect(result).toBe(state);
  });
});

describe('REFRESH_STATS', () => {
  it('overwrites stale stats from a catch-up snapshot and advances lastStatsSeq through the repaired seq', () => {
    const state = makeState({ stats: makeStats({ climbsSentCount: 1 }), lastStatsSeq: 3 });
    const refreshed = makeStats({ climbsSentCount: 9, hardestGrade: 'V10' });

    const result = boardPresenceReducer(state, {
      type: 'REFRESH_STATS',
      payload: { stats: refreshed, upToSeq: 8 },
    });

    expect(result.stats).toEqual(refreshed);
    expect(result.lastStatsSeq).toBe(8);
  });

  it('ignores an older catch-up snapshot so neither stats nor lastStatsSeq regress', () => {
    const freshStats = makeStats({ climbsSentCount: 7 });
    const state = makeState({ stats: freshStats, lastStatsSeq: 12 });

    const result = boardPresenceReducer(state, {
      type: 'REFRESH_STATS',
      payload: { stats: makeStats({ climbsSentCount: 8 }), upToSeq: 10 },
    });

    expect(result).toBe(state);
  });
});

describe('APPLY_CONNECTION_CHANGED', () => {
  it('sets the holder and advances lastConnectionSeq', () => {
    const holder = makeHolder({ userId: 'alice', displayName: 'Alice' });
    const result = boardPresenceReducer(initialBoardPresenceState, {
      type: 'APPLY_CONNECTION_CHANGED',
      payload: { holder, seq: 3 },
    });

    expect(result.holder).toEqual(holder);
    expect(result.lastConnectionSeq).toBe(3);
  });

  it('a higher seq replaces the current holder', () => {
    const first = makeHolder({ userId: 'alice' });
    const state = makeState({ holder: first, lastConnectionSeq: 3 });

    const second = makeHolder({ userId: 'bob' });
    const result = boardPresenceReducer(state, {
      type: 'APPLY_CONNECTION_CHANGED',
      payload: { holder: second, seq: 4 },
    });

    expect(result.holder).toEqual(second);
    expect(result.lastConnectionSeq).toBe(4);
  });

  it('frees the board when the holder is null', () => {
    const state = makeState({ holder: makeHolder(), lastConnectionSeq: 5 });

    const result = boardPresenceReducer(state, {
      type: 'APPLY_CONNECTION_CHANGED',
      payload: { holder: null, seq: 6 },
    });

    expect(result.holder).toBeNull();
    expect(result.lastConnectionSeq).toBe(6);
  });

  it('ignores a stale or duplicate push (seq <= lastConnectionSeq) so out-of-order fan-out cannot regress', () => {
    const current = makeHolder({ userId: 'alice' });
    const state = makeState({ holder: current, lastConnectionSeq: 10 });

    const stale = boardPresenceReducer(state, {
      type: 'APPLY_CONNECTION_CHANGED',
      payload: { holder: makeHolder({ userId: 'bob' }), seq: 9 },
    });
    expect(stale).toBe(state);

    const duplicate = boardPresenceReducer(state, {
      type: 'APPLY_CONNECTION_CHANGED',
      payload: { holder: makeHolder({ userId: 'bob' }), seq: 10 },
    });
    expect(duplicate).toBe(state);
  });

  it('does not touch climb-ordering or stats state', () => {
    const current = makeClimb({ seq: 4 });
    const stats = makeStats({ climbsSentCount: 2 });
    const state = makeState({ currentClimb: current, history: [current], lastSeq: 4, stats, lastStatsSeq: 5 });

    const result = boardPresenceReducer(state, {
      type: 'APPLY_CONNECTION_CHANGED',
      payload: { holder: makeHolder(), seq: 6 },
    });

    expect(result.currentClimb).toEqual(current);
    expect(result.lastSeq).toBe(4);
    expect(result.stats).toBe(stats);
    expect(result.lastStatsSeq).toBe(5);
    expect(result.lastConnectionSeq).toBe(6);
  });
});

describe('SEED_CONNECTION', () => {
  it('fills the holder when no connection event has landed yet, leaving lastConnectionSeq at 0 so a live push still wins', () => {
    const seeded = makeHolder({ userId: 'alice' });
    const afterSeed = boardPresenceReducer(initialBoardPresenceState, { type: 'SEED_CONNECTION', payload: seeded });
    expect(afterSeed.holder).toEqual(seeded);
    expect(afterSeed.lastConnectionSeq).toBe(0);

    // A subsequent live push (any seq > 0) overrides the seed.
    const live = makeHolder({ userId: 'bob' });
    const afterLive = boardPresenceReducer(afterSeed, {
      type: 'APPLY_CONNECTION_CHANGED',
      payload: { holder: live, seq: 1 },
    });
    expect(afterLive.holder).toEqual(live);
    expect(afterLive.lastConnectionSeq).toBe(1);
  });

  it('seeds a null holder (board free) without advancing lastConnectionSeq', () => {
    const result = boardPresenceReducer(initialBoardPresenceState, { type: 'SEED_CONNECTION', payload: null });
    expect(result.holder).toBeNull();
    expect(result.lastConnectionSeq).toBe(0);
  });

  it('is a no-op once a live connection event has landed, so a late cold fetch cannot clobber a fresher push', () => {
    const live = makeHolder({ userId: 'bob' });
    const state = makeState({ holder: live, lastConnectionSeq: 3 });

    const result = boardPresenceReducer(state, { type: 'SEED_CONNECTION', payload: makeHolder({ userId: 'alice' }) });
    expect(result).toBe(state);
  });
});

describe('REFRESH_CONNECTION', () => {
  it('overwrites stale holder state from a catch-up snapshot and advances lastConnectionSeq through the repaired seq', () => {
    const state = makeState({ holder: makeHolder({ userId: 'old' }), lastConnectionSeq: 2 });
    const refreshed = makeHolder({ userId: 'new' });

    const result = boardPresenceReducer(state, {
      type: 'REFRESH_CONNECTION',
      payload: { holder: refreshed, upToSeq: 9 },
    });

    expect(result.holder).toEqual(refreshed);
    expect(result.lastConnectionSeq).toBe(9);
  });

  it('ignores an older catch-up snapshot so neither holder nor lastConnectionSeq regress', () => {
    const state = makeState({ holder: makeHolder({ userId: 'old' }), lastConnectionSeq: 12 });

    const result = boardPresenceReducer(state, {
      type: 'REFRESH_CONNECTION',
      payload: { holder: null, upToSeq: 10 },
    });

    expect(result).toBe(state);
  });
});

describe('RESET', () => {
  it('returns the initial state, clearing stats, holder and the seq cursors', () => {
    const state = makeState({
      currentClimb: makeClimb({ seq: 9 }),
      history: [makeClimb({ seq: 9 })],
      lastSeq: 9,
      stats: makeStats({ climbsSentCount: 4 }),
      lastStatsSeq: 9,
      holder: makeHolder({ userId: 'alice' }),
      lastConnectionSeq: 9,
    });

    expect(boardPresenceReducer(state, { type: 'RESET' })).toEqual(initialBoardPresenceState);
  });
});

describe('mapBoardPresenceEnvelopeToAction', () => {
  it('maps BoardClimbSet to APPLY_CLIMB_SET with the climb', () => {
    const climb = makeClimb({ seq: 1 });
    const event: BoardPresenceEvent = { __typename: 'BoardClimbSet', climb };

    expect(mapBoardPresenceEnvelopeToAction(event)).toEqual({ type: 'APPLY_CLIMB_SET', payload: climb });
  });

  it('maps BoardClimbCleared to APPLY_CLIMB_CLEARED with clearedAt + seq', () => {
    const event: BoardPresenceEvent = {
      __typename: 'BoardClimbCleared',
      clearedAt: '2026-06-09T02:00:00.000Z',
      seq: 12,
    };

    expect(mapBoardPresenceEnvelopeToAction(event)).toEqual({
      type: 'APPLY_CLIMB_CLEARED',
      payload: { clearedAt: '2026-06-09T02:00:00.000Z', seq: 12 },
    });
  });

  it('maps BoardStatsUpdated to APPLY_STATS_UPDATED with the stats + seq', () => {
    const stats = makeStats({ climbsSentCount: 6, hardestGrade: 'V9' });
    const event: BoardPresenceEvent = { __typename: 'BoardStatsUpdated', stats, seq: 21 };

    expect(mapBoardPresenceEnvelopeToAction(event)).toEqual({
      type: 'APPLY_STATS_UPDATED',
      payload: { stats, seq: 21 },
    });
  });

  it('maps BoardConnectionChanged to APPLY_CONNECTION_CHANGED with the holder + seq', () => {
    const holder = makeHolder({ userId: 'alice', displayName: 'Alice' });
    const event: BoardPresenceEvent = { __typename: 'BoardConnectionChanged', holder, seq: 14 };

    expect(mapBoardPresenceEnvelopeToAction(event)).toEqual({
      type: 'APPLY_CONNECTION_CHANGED',
      payload: { holder, seq: 14 },
    });
  });

  it('maps a BoardConnectionChanged with a null holder (board freed)', () => {
    const event: BoardPresenceEvent = { __typename: 'BoardConnectionChanged', holder: null, seq: 15 };

    expect(mapBoardPresenceEnvelopeToAction(event)).toEqual({
      type: 'APPLY_CONNECTION_CHANGED',
      payload: { holder: null, seq: 15 },
    });
  });

  it('returns null for an unknown/absent __typename', () => {
    const event = { climb: makeClimb({ seq: 1 }) } as unknown as BoardPresenceEvent;
    expect(mapBoardPresenceEnvelopeToAction(event)).toBeNull();
  });
});
