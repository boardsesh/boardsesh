import { describe, it, expect } from 'vitest';
import { parseSetIds, normaliseSetIds } from '../set-ids';

describe('parseSetIds', () => {
  it('parses a comma-separated string into numbers', () => {
    expect(parseSetIds('2,10,25')).toEqual([2, 10, 25]);
  });

  it('trims whitespace around each id', () => {
    expect(parseSetIds(' 2 , 10 ')).toEqual([2, 10]);
  });

  it('drops non-numeric tokens', () => {
    expect(parseSetIds('2,foo,10')).toEqual([2, 10]);
  });

  it('drops empty tokens instead of coercing them to 0', () => {
    expect(parseSetIds('')).toEqual([]);
    expect(parseSetIds('2,')).toEqual([2]);
    expect(parseSetIds('2,,10')).toEqual([2, 10]);
  });

  it('passes an array through unchanged', () => {
    expect(parseSetIds([2, 10])).toEqual([2, 10]);
  });
});

describe('normaliseSetIds', () => {
  it('sorts numerically, not lexicographically', () => {
    expect(normaliseSetIds('10,2')).toBe('2,10');
  });

  it('dedupes repeated ids', () => {
    expect(normaliseSetIds('10,2,10')).toBe('2,10');
  });

  it('strips whitespace and empty tokens', () => {
    expect(normaliseSetIds(' 10 , , 2 ')).toBe('2,10');
  });

  it('treats order/whitespace variants of the same set as equal', () => {
    expect(normaliseSetIds('25,2,10')).toBe(normaliseSetIds('2, 10, 25'));
  });

  it('returns an empty string for an empty input', () => {
    expect(normaliseSetIds('')).toBe('');
  });
});
