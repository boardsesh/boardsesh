import { describe, expect, it } from 'vitest';
import { BOARD_DEMAND_REASONS } from '@boardsesh/analytics';
import { boardDemandNeedsFeedback } from '../board-demand-flow';

/**
 * The follow-up split for the demand form (issue #6062), pinned per reason.
 *
 * Three reasons imply a nameable board — a gym's wall we don't list, a brand
 * we don't drive, an answer none of the set covers — and those climbers get
 * handed to the bug-mode feedback sheet so the WHICH can be said in words
 * (which never travel to PostHog). The other two are asks for the feature or
 * for the app itself; the count alone is the record and no second sheet opens.
 */
describe('boardDemandNeedsFeedback', () => {
  it('routes the reasons that imply a nameable board', () => {
    expect(boardDemandNeedsFeedback('gym_board_not_listed')).toBe(true);
    expect(boardDemandNeedsFeedback('unsupported_brand')).toBe(true);
    expect(boardDemandNeedsFeedback('other')).toBe(true);
  });

  it('does not route the feature and app asks', () => {
    expect(boardDemandNeedsFeedback('spray_wall')).toBe(false);
    expect(boardDemandNeedsFeedback('no_board_yet')).toBe(false);
  });

  it('covers every reason the analytics enum can produce', () => {
    // A sixth reason added to the shared enum would silently default to
    // "no follow-up"; this test is what makes that an explicit choice instead.
    const routed = BOARD_DEMAND_REASONS.filter(boardDemandNeedsFeedback);
    expect(routed).toEqual(['gym_board_not_listed', 'unsupported_brand', 'other']);
  });
});
