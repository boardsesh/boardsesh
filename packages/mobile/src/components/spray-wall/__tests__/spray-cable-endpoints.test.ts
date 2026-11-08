import { describe, expect, it } from 'vitest';
import { cableEndpoints } from '../spray-cable-endpoints';

describe('cableEndpoints', () => {
  it('marks only the start and the end of one unbroken cable', () => {
    expect(cableEndpoints([['a', 'b', 'c']])).toEqual({ start: 'a', end: 'c', loose: [] });
  });

  it('marks the ends a cut left unconnected', () => {
    expect(
      cableEndpoints([
        ['a', 'b'],
        ['c', 'd'],
        ['e', 'f'],
      ]),
    ).toEqual({ start: 'a', end: 'f', loose: ['b', 'c', 'd', 'e'] });
  });

  it('marks a one-LED section once, and a loose last LED as both loose and the end', () => {
    expect(cableEndpoints([['a', 'b'], ['c'], ['d']])).toEqual({ start: 'a', end: 'd', loose: ['b', 'c', 'd'] });
  });

  it('marks nothing without a cable', () => {
    expect(cableEndpoints([])).toEqual({ start: null, end: null, loose: [] });
    expect(cableEndpoints([[]])).toEqual({ start: null, end: null, loose: [] });
  });
});
