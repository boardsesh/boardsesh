import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TNUT_CORNERS,
  generateLedPositions,
  generateTnutGrid,
  groupLedPair,
  ledPairs,
  ledPartner,
  readTnutLayout,
  separateLedPair,
  withLedPartners,
  type TnutLayout,
} from '../index';

function layout(ledPlacement: TnutLayout['ledPlacement'] = 'sides'): TnutLayout {
  const configured: TnutLayout = {
    version: 1,
    pattern: 'grid',
    rows: 2,
    columns: 2,
    firstRowOffset: false,
    columnConvention: 'all',
    corners: DEFAULT_TNUT_CORNERS,
    holes: generateTnutGrid({
      pattern: 'grid',
      rows: 2,
      columns: 2,
      firstRowOffset: false,
      corners: DEFAULT_TNUT_CORNERS,
    }),
    ledPlacement,
    photoKey: 'canonical-photo',
  };
  configured.ledPositions = generateLedPositions(configured);
  return configured;
}

describe('LED pairs behind a hold', () => {
  it('pairs the two LEDs a "sides" placement puts behind each hole, and nothing else', () => {
    const sides = layout('sides');
    expect(sides.ledPositions).toHaveLength(8);
    const pairs = ledPairs(sides);
    expect(pairs).toHaveLength(4);
    for (const [first, second] of pairs) {
      const a = sides.ledPositions!.find((led) => led.id === first)!;
      const b = sides.ledPositions!.find((led) => led.id === second)!;
      // Side by side behind the same hole.
      expect(a.hole).toEqual(b.hole);
      expect(a.y).toBeCloseTo(b.y);
    }
    expect(ledPairs(layout('center'))).toEqual([]);
  });

  it('separates a pair and groups two LEDs, and an empty list keeps every pair separated', () => {
    const sides = layout('sides');
    const [first, second] = ledPairs(sides)[0];
    expect(ledPartner(ledPairs(sides), first)).toBe(second);
    const separated = separateLedPair(sides, second);
    expect(ledPartner(ledPairs(separated), first)).toBeNull();
    expect(ledPairs(separated)).toHaveLength(3);
    // Grouping two LEDs takes each out of any pair it was in.
    const [, other] = ledPairs(sides)[1];
    const regrouped = groupLedPair(separated, first, other);
    expect(ledPartner(ledPairs(regrouped), first)).toBe(other);
    expect(ledPairs(regrouped)).toHaveLength(3);
    const none = { ...sides, ledGroups: [] };
    expect(ledPairs(none)).toEqual([]);
  });

  it('survives a save and load, dropping pairs whose LEDs are gone and rejecting malformed ones', () => {
    const sides = layout('sides');
    const [first, second] = ledPairs(sides)[0];
    const stored = JSON.parse(
      JSON.stringify({
        ...sides,
        ledGroups: [
          [first, second],
          [first, 'removed'],
        ],
      }),
    );
    expect(readTnutLayout(stored)?.ledGroups).toEqual([[first, second]]);
    expect(readTnutLayout({ ...stored, ledGroups: [[first]] })).toBeNull();
    expect(readTnutLayout({ ...stored, ledGroups: [[first, first]] })).toBeNull();
    expect(readTnutLayout({ ...stored, ledGroups: [] })?.ledGroups).toEqual([]);
    const { ledGroups: _groups, ...withoutGroups } = stored;
    expect(readTnutLayout(withoutGroups)).not.toHaveProperty('ledGroups');
  });

  it('lays the cable through both LEDs of a pair, once each', () => {
    const pairs = [['a', 'b']] as const;
    expect(withLedPartners(['a', 'c'], pairs, new Set())).toEqual(['a', 'b', 'c']);
    expect(withLedPartners(['b', 'a'], pairs, new Set())).toEqual(['b', 'a']);
    expect(withLedPartners(['a'], pairs, new Set(['b']))).toEqual(['a']);
  });
});
