import { describe, expect, it } from 'vitest';
import {
  createWiring,
  DEFAULT_TNUT_CORNERS,
  expandLedGrid,
  generateLedPositions,
  generateTnutGrid,
  hasStaleLedGrid,
  ledPairs,
  type TnutLayout,
} from '../index';

function grid(size: number, ledPlacement: NonNullable<TnutLayout['ledPlacement']> = 'center') {
  const calibration = {
    pattern: 'grid' as const,
    rows: size,
    columns: size,
    firstRowOffset: false,
    corners: DEFAULT_TNUT_CORNERS,
  };
  const layout = {
    ...calibration,
    version: 1 as const,
    photoKey: 'canonical-photo',
    holes: generateTnutGrid(calibration),
    ledPlacement,
  };
  return { ...layout, ledPositions: generateLedPositions(layout) };
}

describe('expanding a saved LED grid', () => {
  it('keeps old side LEDs and pair choices when pitch changes, and pairs new LEDs', () => {
    const small = grid(2, 'sides');
    const large = grid(3, 'sides');
    const result = expandLedGrid(small, { ...large, ledPositions: small.ledPositions, ledGroups: [] });
    if (!result || result === 'capacity') throw new Error('Expected a larger grid');
    const oldIds = new Set(small.ledPositions.map(({ id }) => id));
    expect(result.needsReview).toBe(false);
    expect(result.layout.ledPositions).toHaveLength(18);
    expect(result.layout.ledPositions).toEqual(expect.arrayContaining(small.ledPositions));
    expect(result.layout.ledGroups).toHaveLength(5);
    expect(result.layout.ledGroups?.flat().every((id) => !oldIds.has(id))).toBe(true);
  });

  it('keeps removed slots removed and hand-made hold links intact', () => {
    const small = grid(2);
    const [removed, first, ...other] = small.ledPositions;
    const ledPositions = [first, ...other];
    const holdLeds = [{ holdId: 5, ledIds: [first.id] }];
    const result = expandLedGrid(small, { ...grid(3), holdLeds, ledPositions });
    if (!result || result === 'capacity') throw new Error('Expected a larger grid');
    expect(result.needsReview).toBe(true);
    expect(result.layout.holdLeds).toEqual(holdLeds);
    expect(result.layout.ledPositions).toHaveLength(8);
    expect(result.layout.ledPositions?.some(({ id }) => id === removed.id)).toBe(false);
  });

  it('keeps implicit side pairs when the old mounting hole leaves the new grid', () => {
    const small = grid(3, 'sides');
    const wiring = createWiring(small.ledPositions, 'horizontal', 'tl', small);
    const result = expandLedGrid(small, { ...grid(4, 'sides'), wiring, ledPositions: small.ledPositions });
    if (!result || result === 'capacity') throw new Error('Expected a larger grid');
    expect(ledPairs(result.layout)).toEqual(expect.arrayContaining(ledPairs(small)));
  });

  it('keeps wired, off-grid LEDs in place without flagging a stale grid next time', () => {
    const small = grid(3);
    const large = grid(4);
    const wiring = createWiring(small.ledPositions, 'vertical', 'bl', small);
    const result = expandLedGrid(small, { ...large, wiring, ledPositions: small.ledPositions });
    if (!result || result === 'capacity') throw new Error('Expected a larger grid');
    expect(result.needsReview).toBe(true);
    expect(result.layout.wiring).toEqual(wiring);
    expect(result.layout.ledPositions).toHaveLength(21);
    expect(result.layout.ledPositions).toEqual(
      expect.arrayContaining(small.ledPositions.map(({ id, x, y }) => expect.objectContaining({ id, x, y }))),
    );
    expect(hasStaleLedGrid(result.layout)).toBe(false);
    expect(expandLedGrid(result.layout, result.layout)).toBeNull();
  });
});
