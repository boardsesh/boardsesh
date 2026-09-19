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

describe('history-only merging', () => {
  it('sorts by microsecond display time and retains richer existing entries', () => {
    const history = mergeBoardHistory([native], [imported, { ...native, name: 'different' }]);
    expect(history).toEqual([native, imported]);
    expect(history[0]).toBe(native);
    expect(mergeBoardHistory(history, [imported, native])).toBe(history);
  });
  it('never changes wall, holder, or statistics when imported history arrives', () => {
    const state = boardPresenceReducer(initialBoardPresenceState, { type: 'APPLY_CLIMB_SET', payload: native });
    const merged = boardPresenceReducer(state, { type: 'MERGE_HISTORY', payload: [imported] });
    expect(merged).toEqual({ ...state, history: [native, imported] });
    const cleared = boardPresenceReducer(merged, {
      type: 'APPLY_CLIMB_CLEARED',
      payload: { seq: 2, clearedAt: native.sentAt },
    });
    expect(cleared.currentClimb).toBeNull();
    expect(cleared.lastSeq).toBe(2);
    expect(boardPresenceReducer(cleared, { type: 'BACKFILL_HISTORY', payload: [imported] })).toBe(cleared);
  });
  it('still applies native live state when history-only backfill arrived first', () => {
    const history = boardPresenceReducer(initialBoardPresenceState, { type: 'MERGE_HISTORY', payload: [native] });
    expect(history.currentClimb).toBeNull();
    const live = boardPresenceReducer(history, { type: 'APPLY_CLIMB_SET', payload: native });
    expect(live.currentClimb).toBe(native);
    expect(live.lastSeq).toBe(1);
  });
});
