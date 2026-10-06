import { describe, expect, it } from 'vitest';
import { ANALYTICS_BOARD_TYPES, boardTypeProperty } from '../board-type-property';

describe('boardTypeProperty', () => {
  it.each(ANALYTICS_BOARD_TYPES)('names the %s board', (boardType) => {
    expect(boardTypeProperty(boardType)).toEqual({ boardType });
  });

  it('tells a spray wall from a Kilter, which a layout id cannot', () => {
    expect(boardTypeProperty('spray').boardType).not.toBe(boardTypeProperty('kilter').boardType);
  });

  it('sends null, not a missing prop, when the board is not known', () => {
    expect(boardTypeProperty(null)).toEqual({ boardType: null });
    expect(boardTypeProperty(undefined)).toEqual({ boardType: null });
    expect(boardTypeProperty('')).toEqual({ boardType: null });
  });

  // The spray telemetry rule: no event may identify a wall. A wall's name, slug
  // or uuid handed over by mistake must not reach PostHog as a value.
  it.each(['The Garage Wall', 'the-garage', '0f8fad5b-d9cb-469f-a165-70867728950e', 'Kilter', 'kilter '])(
    'lets nothing outside the closed set through: %s',
    (notABoardType) => {
      expect(boardTypeProperty(notABoardType)).toEqual({ boardType: null });
    },
  );
});
