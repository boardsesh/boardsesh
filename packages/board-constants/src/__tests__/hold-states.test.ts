import { describe, it, expect } from 'vite-plus/test';
import {
  HOLD_STATE_MAP,
  STATE_TO_PRIMARY_CODE,
  BOARD_RENDER_DEFAULTS,
  getBoardStrokeWidthMultiplier,
  convertLitUpHoldsStringToMap,
  splitFramesString,
  accumulateFramesToMaps,
  accumulatedMapsToFrameStrings,
} from '../hold-states';
import type { BoardName } from '@boardsesh/shared-schema';

describe('HOLD_STATE_MAP', () => {
  const boards: BoardName[] = ['kilter', 'tension', 'moonboard', 'decoy', 'touchstone', 'grasshopper', 'soill'];

  it('has entries for every supported board', () => {
    for (const board of boards) {
      expect(HOLD_STATE_MAP[board]).toBeDefined();
      expect(Object.keys(HOLD_STATE_MAP[board]).length).toBeGreaterThan(0);
    }
  });

  it('every entry has a valid name and color', () => {
    const validStates = new Set(['OFF', 'STARTING', 'FINISH', 'HAND', 'FOOT', 'ANY', 'NOT', 'AUX']);
    for (const board of boards) {
      for (const [_code, info] of Object.entries(HOLD_STATE_MAP[board])) {
        expect(validStates).toContain(info.name);
        expect(info.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
        if (info.displayColor) {
          expect(info.displayColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
        }
      }
    }
  });
});

describe('getBoardStrokeWidthMultiplier', () => {
  it('boosts Grasshopper (issue #2202 — darker/busier board photo)', () => {
    expect(getBoardStrokeWidthMultiplier('grasshopper')).toBe(1.35);
  });

  it('defaults every other board to 1.0 (unchanged rendering)', () => {
    const boards: BoardName[] = ['kilter', 'tension', 'moonboard', 'decoy', 'touchstone', 'soill'];
    for (const board of boards) {
      expect(getBoardStrokeWidthMultiplier(board)).toBe(1.0);
    }
  });

  it('only Grasshopper has a render-defaults override, so other boards stay data-driven-empty', () => {
    expect(Object.keys(BOARD_RENDER_DEFAULTS)).toEqual(['grasshopper']);
  });
});

describe('STATE_TO_PRIMARY_CODE', () => {
  it('kilter uses Product 7 (Homewall) codes', () => {
    expect(STATE_TO_PRIMARY_CODE.kilter).toEqual({
      STARTING: 42,
      HAND: 43,
      FINISH: 44,
      FOOT: 45,
    });
  });

  it('tension uses Product 1 codes', () => {
    expect(STATE_TO_PRIMARY_CODE.tension).toEqual({
      STARTING: 1,
      HAND: 2,
      FINISH: 3,
      FOOT: 4,
    });
  });

  it('moonboard uses saved-climb codes (42-44), not BLE preview codes', () => {
    expect(STATE_TO_PRIMARY_CODE.moonboard).toEqual({
      STARTING: 42,
      HAND: 43,
      FINISH: 44,
    });
  });

  it('all primary codes exist in HOLD_STATE_MAP for their board', () => {
    for (const [boardName, stateMap] of Object.entries(STATE_TO_PRIMARY_CODE)) {
      for (const [state, code] of Object.entries(stateMap)) {
        const info = HOLD_STATE_MAP[boardName as BoardName][code];
        expect(info, `${boardName} code ${code} should exist in HOLD_STATE_MAP`).toBeDefined();
        expect(info.name, `${boardName} code ${code} should map to ${state}`).toBe(state);
      }
    }
  });
});

describe('convertLitUpHoldsStringToMap', () => {
  it('parses a single-frame string', () => {
    const result = convertLitUpHoldsStringToMap('p100r42p200r43p300r44', 'kilter');
    expect(result[0]).toBeDefined();
    expect(result[0][100]).toEqual({
      state: 'STARTING',
      color: '#00FF00',
      displayColor: '#00FF00',
    });
    expect(result[0][200]).toEqual({ state: 'HAND', color: '#00FFFF', displayColor: '#00FFFF' });
    expect(result[0][300]).toEqual({ state: 'FINISH', color: '#FF00FF', displayColor: '#FF00FF' });
  });

  it('parses multi-frame strings separated by commas', () => {
    const result = convertLitUpHoldsStringToMap('p100r1,p200r2', 'tension');
    expect(Object.keys(result)).toHaveLength(2);
    expect(result[0][100].state).toBe('STARTING');
    expect(result[1][200].state).toBe('HAND');
  });

  it('returns empty map for empty string', () => {
    const result = convertLitUpHoldsStringToMap('', 'kilter');
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('handles unknown state codes gracefully', () => {
    const result = convertLitUpHoldsStringToMap('p100r999', 'kilter');
    expect(result[0][100]).toBeDefined();
    expect(result[0][100].color).toBe('#FFF');
  });

  it('uses displayColor when available', () => {
    const result = convertLitUpHoldsStringToMap('p100r1', 'tension');
    expect(result[0][100]).toEqual({
      state: 'STARTING',
      color: '#00FF00',
      displayColor: '#00DD00',
    });
  });
});

describe('splitFramesString', () => {
  it('returns an empty array for the empty string', () => {
    expect(splitFramesString('')).toEqual([]);
  });

  it('returns a single segment for a single-frame string', () => {
    expect(splitFramesString('p100r42p200r43')).toEqual(['p100r42p200r43']);
  });

  it('splits multi-frame strings on commas', () => {
    expect(splitFramesString('p100r42,p200r43,p300r44')).toEqual(['p100r42', 'p200r43', 'p300r44']);
  });

  it('drops empty segments from trailing or doubled commas', () => {
    expect(splitFramesString('p100r42,,p200r43,')).toEqual(['p100r42', 'p200r43']);
  });

  it('strips the leading double-quote Aurora prefixes on later frames', () => {
    // Real Aurora frames look like: `frame0,"frame1,"frame2` — the quote
    // sits at the start of every frame after the first and must be stripped
    // before downstream parsers see it.
    expect(splitFramesString('p100r42,"x100p200r43,"x200p300r44')).toEqual(['p100r42', 'x100p200r43', 'x200p300r44']);
  });
});

describe('accumulateFramesToMaps', () => {
  it('returns an empty array for the empty string', () => {
    expect(accumulateFramesToMaps('', 'tension')).toEqual([]);
  });

  it('returns one snapshot for a single-frame climb', () => {
    const result = accumulateFramesToMaps('p100r1p200r2', 'tension');
    expect(result).toHaveLength(1);
    expect(result[0][100].state).toBe('STARTING');
    expect(result[0][200].state).toBe('HAND');
  });

  it('carries lit holds forward across frames', () => {
    // Frame 0 lights hold 100 (STARTING). Frame 1 adds hold 200 (HAND).
    // After frame 1, both holds should still be lit.
    const result = accumulateFramesToMaps('p100r1,"p200r2', 'tension');
    expect(result).toHaveLength(2);
    expect(Object.keys(result[1]).sort()).toEqual(['100', '200']);
    expect(result[1][100].state).toBe('STARTING');
    expect(result[1][200].state).toBe('HAND');
  });

  it('turns a hold OFF via x<id> tokens without removing other lit holds', () => {
    // Frame 0: 100 STARTING + 200 HAND. Frame 1: x100 (off) + p300 HAND.
    const result = accumulateFramesToMaps('p100r1p200r2,"x100p300r2', 'tension');
    expect(result).toHaveLength(2);
    expect(Object.keys(result[0]).sort()).toEqual(['100', '200']);
    expect(Object.keys(result[1]).sort()).toEqual(['200', '300']);
  });

  it('lets a later frame change a hold to a different role', () => {
    // Frame 0 lights 100 STARTING; frame 1 re-sets 100 to HAND.
    const result = accumulateFramesToMaps('p100r1,"p100r2', 'tension');
    expect(result[0][100].state).toBe('STARTING');
    expect(result[1][100].state).toBe('HAND');
  });

  it('handles a set-then-off within the same frame (off wins)', () => {
    const result = accumulateFramesToMaps('p100r1x100', 'tension');
    expect(result).toHaveLength(1);
    expect(result[0][100]).toBeUndefined();
  });
});

describe('accumulatedMapsToFrameStrings', () => {
  it('emits BLE-friendly snapshots using the board canonical role code', () => {
    const maps = accumulateFramesToMaps('p100r1,"p200r2,"x100p300r3', 'tension');
    const strings = accumulatedMapsToFrameStrings(maps, 'tension');
    // Tension canonical codes: STARTING=1, HAND=2, FINISH=3, FOOT=4.
    expect(strings).toEqual(['p100r1', 'p100r1p200r2', 'p200r2p300r3']);
  });

  it('skips holds whose state has no canonical code on this board', () => {
    // MoonBoard has no FOOT canonical code — a FOOT-state hold should
    // drop out of the BLE string rather than emit `pXrundefined`.
    const maps = [
      {
        100: { state: 'STARTING' as const, color: '#00FF00', displayColor: '#00FF00' },
        200: { state: 'FOOT' as const, color: '#FFAA00', displayColor: '#FFAA00' },
      },
    ];
    const [string0] = accumulatedMapsToFrameStrings(maps, 'moonboard');
    expect(string0).toBe('p100r42');
  });
});
