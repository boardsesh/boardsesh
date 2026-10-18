import { describe, expect, it } from 'vitest';
import { activeHoldsLineCandidates, chooseActiveHoldsLine } from '../active-holds-line';

const MOON = [
  { role: 'STARTING' as const, count: 2, labels: ['B5', 'E5'] },
  { role: 'HAND' as const, count: 4, labels: ['F8', 'K8', 'F10', 'H13'] },
  { role: 'FINISH' as const, count: 1, labels: ['J18'] },
];
const KILTER = [
  { role: 'STARTING' as const, count: 2, labels: null },
  { role: 'HAND' as const, count: 6, labels: null },
  { role: 'FINISH' as const, count: 2, labels: null },
  { role: 'FOOT' as const, count: 4, labels: null },
];
const words = (group: { role: string; count: number }) => `${group.role.toLowerCase()} ${group.count}`;

describe('activeHoldsLineCandidates', () => {
  it('reads coordinates every way, cutting or counting only Hand', () => {
    const candidates = activeHoldsLineCandidates(MOON, words);
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
    expect(activeHoldsLineCandidates(tie, words).handFirst.map((segment) => segment.text)).toEqual([
      'B5 E5',
      'F8…',
      'J18',
    ]);
  });

  it('reads counts with and without the role words', () => {
    const candidates = activeHoldsLineCandidates(KILTER, words);
    expect(candidates.words.map((segment) => segment.text)).toEqual(['starting 2', 'hand 6', 'finish 2', 'foot 4']);
    expect(candidates.counts.map((segment) => segment.text)).toEqual(['2', '6', '2', '4']);
  });
});

describe('chooseActiveHoldsLine', () => {
  const coordinateWidths = { labels: 200, handFirst: 140, handCount: 110 };

  it('draws every coordinate when they fit', () => {
    expect(chooseActiveHoldsLine({ hasLabels: true, widths: coordinateWidths, available: 200 })).toEqual({
      key: 'labels',
      handShrinks: false,
    });
  });

  it('cuts Hand short while its first coordinate still fits', () => {
    expect(chooseActiveHoldsLine({ hasLabels: true, widths: coordinateWidths, available: 150 })).toEqual({
      key: 'labels',
      handShrinks: true,
    });
  });

  it('turns Hand into a count when not even its first coordinate fits, then drops the line', () => {
    expect(chooseActiveHoldsLine({ hasLabels: true, widths: coordinateWidths, available: 120 })).toEqual({
      key: 'handCount',
      handShrinks: false,
    });
    expect(chooseActiveHoldsLine({ hasLabels: true, widths: coordinateWidths, available: 100 })).toBeNull();
  });

  it('keeps the role words when they fit, then bare counts, then no line', () => {
    const widths = { words: 260, counts: 120 };
    expect(chooseActiveHoldsLine({ hasLabels: false, widths, available: 270 })).toEqual({
      key: 'words',
      handShrinks: false,
    });
    expect(chooseActiveHoldsLine({ hasLabels: false, widths, available: 200 })).toEqual({
      key: 'counts',
      handShrinks: false,
    });
    expect(chooseActiveHoldsLine({ hasLabels: false, widths, available: 100 })).toBeNull();
  });

  it('draws a reading that is safe to clip until every width is known', () => {
    expect(chooseActiveHoldsLine({ hasLabels: true, widths: { labels: 200 }, available: 300 })).toEqual({
      key: 'labels',
      handShrinks: true,
    });
    expect(chooseActiveHoldsLine({ hasLabels: false, widths: { words: 100, counts: 50 }, available: null })).toEqual({
      key: 'counts',
      handShrinks: false,
    });
  });
});
