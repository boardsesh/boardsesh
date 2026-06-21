import { describe, it, expect } from 'vitest';
import { convertLitUpHoldsStringToMap, HOLD_STATE_MAP } from '@boardsesh/board-constants';
import type { BoardHold, HoldPlacement } from '../board-renderer/types';

// ── Type structure tests ────────────────────────────────────────────────
// We cannot test the useParseFrames hook (requires React), but we can
// verify the types and the board-constants imports it relies on.

describe('BoardHold type structure', () => {
  it('conforms to expected shape', () => {
    const hold: BoardHold = {
      id: 1,
      cx: 100,
      cy: 200,
      radius: 15,
      color: '#FF0000',
      role: 'STARTING',
      renderStyle: 'circle',
      shape: 'circle',
      brushThickness: 1,
      shapeSize: 1,
    };

    expect(hold.id).toBe(1);
    expect(hold.cx).toBe(100);
    expect(hold.cy).toBe(200);
    expect(hold.radius).toBe(15);
    expect(hold.color).toBe('#FF0000');
    expect(hold.role).toBe('STARTING');
    expect(hold.renderStyle).toBe('circle');
  });

  it('accepts above-marker renderStyle', () => {
    const hold: BoardHold = {
      id: 2,
      cx: 50,
      cy: 75,
      radius: 10,
      color: '#00FF00',
      role: 'FINISH',
      renderStyle: 'above-marker',
      shape: 'circle',
      brushThickness: 1,
      shapeSize: 1,
    };

    expect(hold.renderStyle).toBe('above-marker');
  });
});

describe('HoldPlacement type structure', () => {
  it('conforms to expected shape', () => {
    const placement: HoldPlacement = {
      id: 42,
      mirroredHoldId: null,
      cx: 300,
      cy: 400,
      r: 20,
    };

    expect(placement.id).toBe(42);
    expect(placement.mirroredHoldId).toBeNull();
    expect(placement.cx).toBe(300);
    expect(placement.cy).toBe(400);
    expect(placement.r).toBe(20);
  });

  it('accepts a numeric mirroredHoldId', () => {
    const placement: HoldPlacement = {
      id: 10,
      mirroredHoldId: 20,
      cx: 100,
      cy: 200,
      r: 15,
    };

    expect(placement.mirroredHoldId).toBe(20);
  });
});

describe('board-constants imports', () => {
  it('convertLitUpHoldsStringToMap is importable and is a function', () => {
    expect(typeof convertLitUpHoldsStringToMap).toBe('function');
  });

  it('HOLD_STATE_MAP is importable and is an object with board keys', () => {
    expect(typeof HOLD_STATE_MAP).toBe('object');
    expect(HOLD_STATE_MAP).not.toBeNull();
    // Should have at least kilter and tension entries
    expect('kilter' in HOLD_STATE_MAP).toBe(true);
    expect('tension' in HOLD_STATE_MAP).toBe(true);
  });

  it('convertLitUpHoldsStringToMap returns empty object for empty frames', () => {
    const result = convertLitUpHoldsStringToMap('', 'kilter');
    expect(result).toEqual({});
  });
});
