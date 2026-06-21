import { describe, it, expect } from 'vitest';
import { deriveFeedScopeInput } from '../feed/feed-scope';

describe('deriveFeedScopeInput', () => {
  it('crew mode is followingOnly across all boards, never board-filtered', () => {
    const expected = { followingOnly: true, includeDailyHighlights: true };
    // The selected board is ignored in crew mode (no boardUuid in the input).
    expect(deriveFeedScopeInput('crew', 'board-1')).toEqual(expected);
    expect(deriveFeedScopeInput('crew', null)).toEqual(expected);
  });

  it('gym mode with a board scopes by boardUuid, not followingOnly', () => {
    expect(deriveFeedScopeInput('gym', 'board-7')).toEqual({
      boardUuid: 'board-7',
      followingOnly: false,
      includeDailyHighlights: true,
    });
  });

  it('gym mode with a null board is the global "Everyone" feed', () => {
    expect(deriveFeedScopeInput('gym', null)).toEqual({
      boardUuid: null,
      followingOnly: false,
      includeDailyHighlights: true,
    });
  });
});
