import { describe, expect, it, vi } from 'vitest';
import { expandRounds, isRoundNumber, locateRound } from '../index';

type Item = { uuid: string; climb: string };

const ROUND_ONE: Item[] = [
  { uuid: 'a', climb: 'A' },
  { uuid: 'b', climb: 'B' },
  { uuid: 'c', climb: 'C' },
];
const copyForRound = (item: Item, round: number): Item => ({ ...item, uuid: `${item.uuid}${round}` });

describe('expandRounds', () => {
  it('repeats the climbs round-major, round 1 keeping its uuids', () => {
    const expanded = expandRounds(ROUND_ONE, 3, copyForRound);

    expect(expanded.map(({ item, round }) => [item.climb, item.uuid, round])).toEqual([
      ['A', 'a', 1],
      ['B', 'b', 1],
      ['C', 'c', 1],
      ['A', 'a2', 2],
      ['B', 'b2', 2],
      ['C', 'c2', 2],
      ['A', 'a3', 3],
      ['B', 'b3', 3],
      ['C', 'c3', 3],
    ]);
    expect(expanded[0].item).toBe(ROUND_ONE[0]);
  });

  it('asks for a copy of every item in every round after the first', () => {
    const copy = vi.fn(copyForRound);
    expandRounds(ROUND_ONE, 2, copy);

    expect(copy.mock.calls.map(([item, round]) => [item.uuid, round])).toEqual([
      ['a', 2],
      ['b', 2],
      ['c', 2],
    ]);
  });

  it('gives round 1 alone for one round, none, or a broken count', () => {
    for (const rounds of [1, 0, -2, Number.NaN]) {
      expect(expandRounds(ROUND_ONE, rounds, copyForRound).map(({ item, round }) => [item.uuid, round])).toEqual([
        ['a', 1],
        ['b', 1],
        ['c', 1],
      ]);
    }
  });

  it('expands nothing to nothing', () => {
    expect(expandRounds([], 4, copyForRound)).toEqual([]);
  });
});

describe('isRoundNumber', () => {
  it('accepts whole numbers from 1 only', () => {
    expect([1, 4, 10].every(isRoundNumber)).toBe(true);
    expect([0, -1, 1.5, Number.NaN, '2', null, undefined].some(isRoundNumber)).toBe(false);
  });
});

describe('locateRound', () => {
  // A 3x2: three climbs, two rounds, in queue order.
  const QUEUED = ['a', 'b', 'c', 'a2', 'b2', 'c2'];
  const ROUNDS = { a: 1, b: 1, c: 1, a2: 2, b2: 2, c2: 2 };

  it('places a climb in its round', () => {
    expect(locateRound(QUEUED, ROUNDS, 'a')).toEqual({ round: 1, roundCount: 2, positionInRound: 1, roundSize: 3 });
    expect(locateRound(QUEUED, ROUNDS, 'b2')).toEqual({ round: 2, roundCount: 2, positionInRound: 2, roundSize: 3 });
    expect(locateRound(QUEUED, ROUNDS, 'c2')).toEqual({ round: 2, roundCount: 2, positionInRound: 3, roundSize: 3 });
  });

  it('keeps the stored round through a reorder, counting positions in queue order', () => {
    const reordered = ['b2', 'a', 'b', 'c', 'a2', 'c2'];

    expect(locateRound(reordered, ROUNDS, 'b2')).toEqual({ round: 2, roundCount: 2, positionInRound: 1, roundSize: 3 });
    expect(locateRound(reordered, ROUNDS, 'a2')).toMatchObject({ round: 2, positionInRound: 2 });
  });

  it('counts only queued climbs, and skips a round with none left', () => {
    expect(locateRound(['a', 'b', 'a2'], ROUNDS, 'a2')).toEqual({
      round: 2,
      roundCount: 2,
      positionInRound: 1,
      roundSize: 1,
    });
    expect(locateRound(['a2', 'b2', 'c2'], ROUNDS, 'b2')).toEqual({
      round: 1,
      roundCount: 1,
      positionInRound: 2,
      roundSize: 3,
    });
  });

  it('is null for a climb with no round, a broken round or one not queued', () => {
    expect(locateRound([...QUEUED, 'extra'], ROUNDS, 'extra')).toBeNull();
    expect(locateRound(QUEUED, { ...ROUNDS, a: 0 }, 'a')).toBeNull();
    expect(locateRound(['b', 'c'], ROUNDS, 'a')).toBeNull();
    expect(locateRound(['constructor'], ROUNDS, 'constructor')).toBeNull();
  });

  it('leaves climbs without a round out of every count', () => {
    const { a: _a, ...withoutA } = ROUNDS;

    expect(locateRound(QUEUED, withoutA, 'b')).toEqual({ round: 1, roundCount: 2, positionInRound: 1, roundSize: 2 });
  });
});
