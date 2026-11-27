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
  it('detaches and reconnects whole reversed stripes in their physical order', () => {
    const original: TnutWiring = {
      direction: 'custom',
      startCorner: 'tl',
      paths: [['c', 'b', 'a', 'd', 'e', 'f']],
      initialSkip: 2,
      skips: [{ from: 'a', to: 'd', count: 3 }],
    };
    const first = ['a', 'b', 'c'];
    const second = ['d', 'e', 'f'];
    const split = planCableUnitEdits(original, first, second).cut;
    expect(split.paths).toEqual([['c', 'b', 'a']]);
    // Cutting removes that connection's skipped segment, as for existing pairs.
    const connected = planCableUnitEdits(split, second, first).joined;
    expect(connected.paths).toEqual(original.paths);
    expect(assignLedIndices(connected).map(({ id }) => id)).toEqual(assignLedIndices(original).map(({ id }) => id));
  });

  it('never edits a stripe whose saved members were reordered or split', () => {
    const invalid = { ...wiring, paths: [['a', 'c', 'b', 'd']] };
    expect(planCableUnitEdits(invalid, ['a', 'b', 'c'], ['d'])).toEqual({ cut: invalid, joined: invalid });
  });

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
    [['e'], ['f'], [['b', 'a', 'd', 'c', 'e']]],
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

  it('detaches a terminal LED while retaining the controller-connected first LED', () => {
    const two: TnutWiring = { ...wiring, paths: [['a', 'b']], skips: [{ from: 'a', to: 'b', count: 2 }] };
    const cut = planCableUnitEdits(two, ['b'], ['a']).cut;
    expect(cut.paths).toEqual([['a']]);
    expect(cut.skips).toEqual([]);
    expect(cut.initialSkip).toBe(3);
    expect(assignLedIndices(cut)).toEqual([{ id: 'a', index: 3 }]);
  });

  it('keeps an upstream singleton when an interior cut leaves a longer downstream section', () => {
    const three: TnutWiring = { ...wiring, paths: [['a', 'b', 'c']], skips: [] };
    expect(planCableUnitEdits(three, ['a'], ['b']).cut.paths).toEqual([['a'], ['b', 'c']]);
  });

  it('detaches a whole terminal pair and removes only its obsolete skips', () => {
    const paired: TnutWiring = {
      ...wiring,
      paths: [['a', 'b', 'c', 'd']],
      skips: [
        { from: 'a', to: 'b', count: 1 },
        { from: 'b', to: 'c', count: 2 },
        { from: 'c', to: 'd', count: 3 },
      ],
    };
    const cut = planCableUnitEdits(paired, ['b'], ['d', 'c']).cut;
    expect(cut.paths).toEqual([['a', 'b']]);
    expect(cut.skips).toEqual([{ from: 'a', to: 'b', count: 1 }]);
    expect(cut.initialSkip).toBe(paired.initialSkip);
  });

  it('leaves other existing singleton sections intact when detaching a tail', () => {
    const sectioned: TnutWiring = { ...wiring, paths: [['a'], ['b', 'c'], ['d']], skips: [] };
    expect(planCableUnitEdits(sectioned, ['b'], ['c']).cut.paths).toEqual([['a'], ['b'], ['d']]);
  });
});
