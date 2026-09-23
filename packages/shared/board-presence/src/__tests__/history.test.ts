import { describe, it, expect } from 'vitest';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { mergeBoardHistory } from '../history';
import { boardPresenceReducer, initialBoardPresenceState } from '../reducer';

const native: BoardPresenceClimb = { climbUuid: 'native', seq: 1, sentAt: '2026-09-18T10:00:00.123Z' };
const imported: BoardPresenceClimb = {
  climbUuid: 'imported',
  seq: 10,
  source: 'kilter',
  sentAt: '2026-09-18T10:00:00.122999Z',
};
const newerImport: BoardPresenceClimb = { ...imported, sentAt: '2026-09-18T10:00:00.123001Z' };

const merge = (state: typeof initialBoardPresenceState, climbs: BoardPresenceClimb[]) =>
  boardPresenceReducer(state, { type: 'MERGE_HISTORY', payload: climbs });
const clear = (state: typeof initialBoardPresenceState, clearedAt = '2026-09-18T10:01:00Z') =>
  boardPresenceReducer(state, { type: 'APPLY_CLIMB_CLEARED', payload: { seq: 2, clearedAt } });

describe('mixed-source current climb', () => {
  it('sorts by microsecond display time and retains richer existing entries', () => {
    const history = mergeBoardHistory([native], [imported, { ...native, name: 'different' }]);
    expect(history).toEqual([native, imported]);
    expect(history[0]).toBe(native);
    expect(mergeBoardHistory(history, [imported, native])).toBe(history);
  });

  it('distinguishes UTC displays within the same millisecond', () => {
    const first = { ...native, sentAt: '2026-09-18T10:00:00.122001Z' };
    const later = { ...imported, sentAt: '2026-09-18T10:00:00.122999Z' };
    expect(Date.parse(first.sentAt)).toBe(Date.parse(later.sentAt));
    expect(mergeBoardHistory([first], [later])).toEqual([later, first]);
    expect(merge(initialBoardPresenceState, [first, later]).currentClimb).toBe(later);
  });

  it('deduplicates native live delivery after mixed backfill and retains older missing history', () => {
    const latest = { ...native, seq: 3 };
    const state = merge(initialBoardPresenceState, [latest, newerImport]);
    expect(boardPresenceReducer(state, { type: 'APPLY_CLIMB_SET', payload: { ...latest } })).toBe(state);
    const older = { ...native, seq: 2, sentAt: '2026-09-18T09:59:00Z' };
    const result = boardPresenceReducer(state, { type: 'APPLY_CLIMB_SET', payload: older });
    expect(result.currentClimb).toBe(newerImport);
    expect(result.lastSeq).toBe(3);
    expect(result.history).toEqual([newerImport, latest, older]);
  });

  it('uses the latest native clear across a set and imported display between clears', () => {
    const firstClear = clear(merge(initialBoardPresenceState, [native]));
    const nextNative = { ...native, seq: 3, sentAt: '2026-09-18T10:02:00Z' };
    const nextImport = { ...newerImport, sentAt: '2026-09-18T10:03:00Z' };
    const betweenClears = merge(boardPresenceReducer(firstClear, { type: 'APPLY_CLIMB_SET', payload: nextNative }), [
      nextImport,
    ]);
    expect(betweenClears.currentClimb).toBe(nextImport);
    const secondClear = boardPresenceReducer(betweenClears, {
      type: 'APPLY_CLIMB_CLEARED',
      payload: { seq: 4, clearedAt: '2026-09-18T10:04:00Z' },
    });
    expect(secondClear.currentClimb).toBeNull();
    expect(merge(secondClear, [nextImport])).toBe(secondClear);
    expect(clear(secondClear)).toBe(secondClear);
    const afterClear = { ...nextImport, seq: 11, sentAt: '2026-09-18T10:05:00Z' };
    expect(merge(secondClear, [afterClear]).currentClimb).toBe(afterClear);
  });

  it('keeps a newer native climb despite a higher imported sequence', () => {
    const state = boardPresenceReducer(initialBoardPresenceState, { type: 'APPLY_CLIMB_SET', payload: native });
    expect(merge(state, [imported])).toEqual({ ...state, history: [native, imported] });
  });

  it('adopts a newer Kilter display without changing native cursor, holder, or stats', () => {
    const state = {
      ...merge(initialBoardPresenceState, [native]),
      holder: { userId: 'climber', displayName: 'Climber', avatarUrl: null, lastSentAt: native.sentAt },
      lastConnectionSeq: 3,
      stats: { climbsSentCount: 4, distinctClimbersCount: 2, hardestGrade: null, topGrade: null, lastSentAt: null },
      lastStatsSeq: 4,
    };
    const result = merge(state, [newerImport]);
    expect(result).toEqual({
      ...state,
      currentClimb: newerImport,
      previousClimb: native,
      history: [newerImport, native],
    });
    expect(merge(result, [{ ...newerImport }])).toBe(result);
  });

  it.each(['native-first', 'kilter-first'] as const)('converges on initial load: %s', (order) => {
    const first = order === 'native-first' ? native : newerImport;
    const second = order === 'native-first' ? newerImport : native;
    const result = merge(merge(initialBoardPresenceState, [first]), [second]);
    expect(result.currentClimb).toBe(newerImport);
    expect(result.lastSeq).toBe(native.seq);
    expect(result.history).toEqual([newerImport, native]);
  });

  it.each(['APPLY_CLIMB_SET', 'BACKFILL_HISTORY'] as const)(
    'a late native %s cannot displace a more recently displayed Kilter climb',
    (type) => {
      const state = merge(initialBoardPresenceState, [newerImport]);
      const result = boardPresenceReducer(
        state,
        type === 'APPLY_CLIMB_SET' ? { type, payload: native } : { type, payload: [native] },
      );
      expect(result.currentClimb).toBe(newerImport);
      expect(result.previousClimb).toBeNull();
      expect(result.lastSeq).toBe(native.seq);
    },
  );

  it('accepts a newer native display even when its sequence is lower than the import sequence', () => {
    const state = merge(initialBoardPresenceState, [native, newerImport]);
    const nextNative = { ...native, seq: 2, sentAt: '2026-09-18T10:00:01Z' };
    const result = boardPresenceReducer(state, { type: 'APPLY_CLIMB_SET', payload: nextNative });
    expect(result.currentClimb).toBe(nextNative);
    expect(result.previousClimb).toBe(newerImport);
    expect(result.lastSeq).toBe(2);
  });

  it.each(['2026-09-18T10:00:00.123000Z', '2026-09-18T12:00:00.123+02:00'])(
    'prefers native at equal display times (%s), independently of arrival order',
    (sentAt) => {
      const tiedImport = { ...imported, sentAt };
      expect(merge(merge(initialBoardPresenceState, [native]), [tiedImport]).currentClimb).toBe(native);
      expect(merge(merge(initialBoardPresenceState, [tiedImport]), [native]).currentClimb).toBe(native);
    },
  );

  it('does not resurrect a cleared wall when older Kilter history arrives or replays', () => {
    const state = clear(merge(initialBoardPresenceState, [native, newerImport]));
    expect(state.currentClimb).toBeNull();
    expect(state.previousClimb).toBe(newerImport);
    expect(merge(state, [newerImport])).toBe(state);
    expect(merge(state, [{ ...imported, seq: 50 }]).currentClimb).toBeNull();
    expect(boardPresenceReducer(state, { type: 'BACKFILL_HISTORY', payload: [native] })).toBe(state);
  });

  it.each(['clear-first', 'import-first'] as const)(
    'keeps a Kilter display newer than an observed clear: %s',
    (order) => {
      const state = merge(initialBoardPresenceState, [native]);
      const result =
        order === 'clear-first'
          ? merge(clear(state, native.sentAt), [newerImport])
          : clear(merge(state, [newerImport]), native.sentAt);
      expect(result.currentClimb).toBe(newerImport);
      expect(result.lastSeq).toBe(2);
    },
  );

  it('rejects an imported display at exactly the clear timestamp', () => {
    const state = clear(merge(initialBoardPresenceState, [native]), native.sentAt);
    expect(merge(state, [{ ...imported, sentAt: native.sentAt }]).currentClimb).toBeNull();
  });

  it('does not promote an imported entry with an invalid timestamp', () => {
    expect(merge(initialBoardPresenceState, [{ ...imported, sentAt: 'invalid' }]).currentClimb).toBeNull();
  });

  it('resets the imported display and clear timestamp when switching boards', () => {
    const state = clear(merge(initialBoardPresenceState, [newerImport]));
    expect(boardPresenceReducer(state, { type: 'RESET' })).toBe(initialBoardPresenceState);
  });
});
