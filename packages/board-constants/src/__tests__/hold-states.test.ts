import { describe, it, expect } from 'vite-plus/test';
import { HOLD_STATE_MAP, STATE_TO_PRIMARY_CODE, convertLitUpHoldsStringToMap } from '../hold-states';
import type { BoardName } from '@boardsesh/shared-schema';

describe('HOLD_STATE_MAP', () => {
  const boards: BoardName[] = ['kilter', 'tension', 'moonboard', 'decoy', 'touchstone', 'grasshopper'];

  it('has entries for every supported board', () => {
    for (const board of boards) {
      expect(HOLD_STATE_MAP[board]).toBeDefined();
      expect(Object.keys(HOLD_STATE_MAP[board]).length).toBeGreaterThan(0);
    }
  });

  it('every entry has a valid name and color', () => {
    const validStates = new Set(['OFF', 'STARTING', 'FINISH', 'HAND', 'FOOT', 'ANY', 'NOT', 'AUX']);
    for (const board of boards) {
      for (const [, info] of Object.entries(HOLD_STATE_MAP[board])) {
        expect(validStates).toContain(info.name);
        expect(info.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
        if (info.displayColor) {
          expect(info.displayColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
        }
      }
    }
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
