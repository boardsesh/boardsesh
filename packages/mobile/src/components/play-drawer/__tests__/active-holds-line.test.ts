import { describe, expect, it } from 'vitest';
import { activeHoldsLineCandidates, activeHoldsLineWidthKey, chooseActiveHoldsLine } from '../active-holds-line';

const MOON = [
  { role: 'STARTING' as const, count: 2, labels: ['B5', 'E5'] },
  { role: 'HAND' as const, count: 4, labels: ['F8', 'K8', 'F10', 'H13'] },
  { role: 'FINISH' as const, count: 1, labels: ['J18'] },
];

describe('activeHoldsLineCandidates', () => {
  it('reads coordinates every way, cutting or counting only Hand', () => {
    const candidates = activeHoldsLineCandidates(MOON);
    expect(candidates.labels.map((segment) => segment.text)).toEqual(['B5 E5', 'F8 K8 F10 H13', 'J18']);
    expect(candidates.handFirst.map((segment) => segment.text)).toEqual(['B5 E5', 'F8…', 'J18']);
    expect(candidates.handCount.map((segment) => segment.text)).toEqual(['B5 E5', '4', 'J18']);
  });

  it('cuts nothing when Start ties Hand: Hand is the one that shrinks, never Start', () => {
    const tie = [
      { role: 'STARTING' as const, count: 2, labels: ['B5', 'E5'] },
      { role: 'HAND' as const, count: 2, labels: ['F8', 'K11'] },
      { role: 'FINISH' as const, count: 1, labels: ['J18'] },
    ];
    expect(activeHoldsLineCandidates(tie).handFirst.map((segment) => segment.text)).toEqual(['B5 E5', 'F8…', 'J18']);
  });
});

describe('chooseActiveHoldsLine', () => {
  const widths = { labels: 200, handFirst: 140, handCount: 110 };

  it('draws every coordinate when they fit', () => {
    expect(chooseActiveHoldsLine({ widths, available: 200 })).toEqual({ key: 'labels', handShrinks: false });
  });

  it('cuts Hand short while its first coordinate still fits', () => {
    expect(chooseActiveHoldsLine({ widths, available: 150 })).toEqual({ key: 'labels', handShrinks: true });
  });

  it('turns Hand into a count when not even its first coordinate fits, then drops the line', () => {
    expect(chooseActiveHoldsLine({ widths, available: 120 })).toEqual({ key: 'handCount', handShrinks: false });
    expect(chooseActiveHoldsLine({ widths, available: 100 })).toBeNull();
  });
});

describe('chooseActiveHoldsLine before the widths land', () => {
  it('draws every coordinate with Hand shrinking when it has drawn nothing yet', () => {
    expect(chooseActiveHoldsLine({ widths: { labels: 200 }, available: 300 })).toEqual({
      key: 'labels',
      handShrinks: true,
    });
  });

  it('keeps the reading it drew last', () => {
    expect(
      chooseActiveHoldsLine({ widths: {}, available: 300, lastChoice: { key: 'handCount', handShrinks: false } }),
    ).toEqual({ key: 'handCount', handShrinks: false });
    // The title standing in stays until the new climb is measured.
    expect(chooseActiveHoldsLine({ widths: {}, available: 300, lastChoice: null })).toBeNull();
    // After every coordinate, Hand may shrink in the meantime: if they fit, nothing shrinks.
    expect(
      chooseActiveHoldsLine({ widths: {}, available: 300, lastChoice: { key: 'labels', handShrinks: false } }),
    ).toEqual({ key: 'labels', handShrinks: true });
  });
});

describe('activeHoldsLineWidthKey', () => {
  it('ignores which digits a reading has, since they are tabular, but not its letters or size', () => {
    const segments = (texts: string[]) => texts.map((text) => ({ role: 'HAND' as const, text }));
    expect(activeHoldsLineWidthKey(1, 18, 'labels', segments(['F8 K10']))).toBe(
      activeHoldsLineWidthKey(1, 18, 'labels', segments(['F9 K12'])),
    );
    expect(activeHoldsLineWidthKey(1, 18, 'labels', segments(['B5']))).not.toBe(
      activeHoldsLineWidthKey(1, 18, 'labels', segments(['K5'])),
    );
    expect(activeHoldsLineWidthKey(1, 18, 'labels', segments(['B5']))).not.toBe(
      activeHoldsLineWidthKey(1.12, 20, 'labels', segments(['B5'])),
    );
  });
});
