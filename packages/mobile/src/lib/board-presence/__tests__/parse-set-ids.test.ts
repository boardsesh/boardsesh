import { describe, it, expect } from 'vitest';
import { parseSetIds } from '../parse-set-ids';

describe('parseSetIds', () => {
  it('parses a comma-separated list', () => {
    expect(parseSetIds('1,2,3')).toEqual([1, 2, 3]);
  });

  it('parses a single id', () => {
    expect(parseSetIds('12')).toEqual([12]);
  });

  it('returns [] for an empty string (not [0])', () => {
    // Regression guard: Number('') is 0 (finite), so a naive parse would yield [0]
    // and slip past a length===0 fallback, rendering an invalid board.
    expect(parseSetIds('')).toEqual([]);
  });

  it('drops empty tokens from trailing/duplicate commas', () => {
    expect(parseSetIds('1,,2,')).toEqual([1, 2]);
  });

  it('trims whitespace around ids', () => {
    expect(parseSetIds(' 3 , 4 ')).toEqual([3, 4]);
  });

  it('drops non-numeric tokens', () => {
    expect(parseSetIds('1,abc,2')).toEqual([1, 2]);
  });
});
