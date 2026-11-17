import { describe, expect, it } from 'vitest';
import { assignLedIndices, type TnutWiring } from '@boardsesh/spray-wall-geometry';
import { planCableUnitEdits } from '../spray-cable-unit-edits';

const wiring: TnutWiring = {
  direction: 'custom',
  startCorner: 'tl',
  initialSkip: 3,
  paths: [['b', 'a', 'd', 'c', 'e', 'f']],
  skips: [{ from: 'e', to: 'f', count: 2 }],
};

describe('cable edits for selected LED units', () => {
  it.each([
    [
      ['a', 'b'],
      ['c', 'd'],
      [
        ['b', 'a'],
        ['d', 'c', 'e', 'f'],
      ],
    ],
    [
      ['c', 'd'],
      ['e'],
      [
        ['b', 'a', 'd', 'c'],
        ['e', 'f'],
      ],
    ],
    [['e'], ['f'], [['b', 'a', 'd', 'c', 'e'], ['f']]],
  ] as const)('cuts only the boundary of %j and %j', (first, second, paths) => {
    expect(planCableUnitEdits(wiring, first, second).cut.paths).toEqual(paths);
  });

  it('reconnects whole paired sections in their saved physical direction', () => {
    const cut = planCableUnitEdits(wiring, ['a', 'b'], ['c', 'd']).cut;
    const rejoined = planCableUnitEdits(cut, ['c', 'd'], ['a', 'b']).joined;
    expect(rejoined).toEqual(wiring);
    expect(assignLedIndices(rejoined)).toEqual(assignLedIndices(wiring));
  });

  it.each([
    [['b', 'd'], ['e']],
    [['a', 'missing'], ['e']],
    [['a', 'b'], ['f']],
  ] as const)('preserves a saved split, partial or nonadjacent unit %j', (first, second) => {
    expect(planCableUnitEdits(wiring, first, second)).toEqual({ cut: wiring, joined: wiring });
  });

  it('adds all members when joining an unwired pair to the tail', () => {
    const next = planCableUnitEdits(wiring, ['g', 'h'], ['f']).joined;
    expect(next.paths).toEqual([['b', 'a', 'd', 'c', 'e', 'f', 'g', 'h']]);
    expect(next.skips).toEqual(wiring.skips);
  });
});
