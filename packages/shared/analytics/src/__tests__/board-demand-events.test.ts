import { describe, expect, it } from 'vitest';
import { SHARED_EVENTS } from '../events';
import {
  BOARD_DEMAND_REASONS,
  BOARD_DEMAND_SURFACES,
  boardDemandReported,
  needsBoardDemandFollowUp,
} from '../board-demand-events';

/**
 * Shape tests for the board demand builder — the same two rules the spray wall
 * file enforces, for the same reason.
 *
 *  - the builder pairs the demand name with the demand properties, so a call
 *    site cannot hand a surface string to some other event;
 *  - **the payload stays a closed set.** The free-text box on the form is the
 *    point: what the climber typed belongs to the feedback pipeline, never to
 *    PostHog, because a demand note can name a person, a gym, or a town. The
 *    forbidden-key sweep is what catches a future builder that grows a `note`
 *    or a `gymName` field in a hurry.
 */

/** Keys that must never appear in a demand payload, whatever it grows into. */
const FORBIDDEN_KEY_FRAGMENTS = ['uri', 'url', 'name', 'uuid', 'path', 'file', 'note', 'text', 'free', 'email'];

const EVERY_PAYLOAD = BOARD_DEMAND_REASONS.flatMap((reason) =>
  BOARD_DEMAND_SURFACES.map((surface) => boardDemandReported(reason, surface)),
);

describe('board demand event builder', () => {
  it('pairs the shared name with its own properties', () => {
    expect(boardDemandReported('spray_wall', 'board_picker')).toEqual({
      name: SHARED_EVENTS.BoardDemandReported,
      properties: { reason: 'spray_wall', surface: 'board_picker' },
    });
    expect(boardDemandReported('no_board_yet', 'first_board')).toEqual({
      name: SHARED_EVENTS.BoardDemandReported,
      properties: { reason: 'no_board_yet', surface: 'first_board' },
    });
  });

  it('uses a name from the shared catalog', () => {
    const catalogNames = new Set<string>(Object.values(SHARED_EVENTS));
    for (const payload of EVERY_PAYLOAD) {
      expect(catalogNames.has(payload.name), payload.name).toBe(true);
    }
  });

  it('carries nothing but the two closed-set fields', () => {
    for (const payload of EVERY_PAYLOAD) {
      const keys = Object.keys(payload.properties);
      expect(keys).toEqual(['reason', 'surface']);
      for (const [key, value] of Object.entries(payload.properties)) {
        const lowered = key.toLowerCase();
        for (const fragment of FORBIDDEN_KEY_FRAGMENTS) {
          expect(lowered.includes(fragment), `${payload.name}.${key}`).toBe(false);
        }
        // Closed-set strings only, and short enough that no free text hid in
        // one. 'gym_directory' is a value, not a key, so the gym word passes.
        expect(typeof value).toBe('string');
        expect(value.length, `${payload.name}.${key}`).toBeLessThan(24);
      }
    }
  });

  it('keeps every reason and surface enumerated', () => {
    // The dashboard groups on these two fields, so a call site inventing a
    // sixth reason silently splits the chart. The enums above are the contract
    // the i18n option lists and both platforms' sheets are built from.
    expect(BOARD_DEMAND_REASONS).toContain('gym_board_not_listed');
    expect(BOARD_DEMAND_SURFACES).toContain('gym_directory');
  });

  it('routes exactly the nameable-board reasons to a follow-up', () => {
    // Both platforms branch on this predicate (mobile opens its bug-mode
    // sheet, www links to the support page), so the split is the reporting
    // contract too: three reasons that can be NAMED, two feature/app asks
    // where the count alone is the record.
    expect(BOARD_DEMAND_REASONS.filter(needsBoardDemandFollowUp)).toEqual([
      'gym_board_not_listed',
      'unsupported_brand',
      'other',
    ]);
  });
});
