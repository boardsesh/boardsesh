import { describe, it, expect } from 'vitest';
import { climbNameLikePattern } from '../climb-name-pattern';

describe('climbNameLikePattern', () => {
  it('wraps a plain query in a substring pattern', () => {
    expect(climbNameLikePattern('gaston')).toBe('%gaston%');
  });

  it('trims the query before building the pattern', () => {
    expect(climbNameLikePattern('  gaston  ')).toBe('%gaston%');
  });

  // #5353: iOS Smart Punctuation types `’`; the catalogue has both forms.
  it('turns every apostrophe and quote variant into a one-character wildcard', () => {
    expect(climbNameLikePattern('Joey’s')).toBe('%Joey_s%');
    expect(climbNameLikePattern("Joey's")).toBe('%Joey_s%');
    expect(climbNameLikePattern('Joey‘s')).toBe('%Joey_s%');
    expect(climbNameLikePattern('Joeyʼs')).toBe('%Joey_s%');
    expect(climbNameLikePattern('Joey`s')).toBe('%Joey_s%');
    expect(climbNameLikePattern('“Big” one')).toBe('%_Big_%one%');
    expect(climbNameLikePattern('"Big"')).toBe('%_Big_%');
  });

  it('turns every hyphen and dash variant into a one-character wildcard', () => {
    expect(climbNameLikePattern('Spider-Man')).toBe('%Spider_Man%');
    expect(climbNameLikePattern('Spider–Man')).toBe('%Spider_Man%');
    expect(climbNameLikePattern('Spider—Man')).toBe('%Spider_Man%');
  });

  it('turns each whitespace run into one any-length wildcard', () => {
    expect(climbNameLikePattern('Joey’s Gaston')).toBe('%Joey_s%Gaston%');
    expect(climbNameLikePattern('joey   gaston')).toBe('%joey%gaston%');
    expect(climbNameLikePattern('joey gaston')).toBe('%joey%gaston%');
  });

  it("still escapes the user's own LIKE metacharacters", () => {
    expect(climbNameLikePattern('50%')).toBe('%50\\%%');
    expect(climbNameLikePattern('a_b')).toBe('%a\\_b%');
    expect(climbNameLikePattern('back\\slash')).toBe('%back\\\\slash%');
  });

  // An all-match `%%` would leak the by-name exceptions (hidden climbs, Woods
  // cross-angle) into an unfiltered list, so whitespace-only input stays literal.
  it('keeps whitespace-only input literal instead of matching every climb', () => {
    expect(climbNameLikePattern('  ')).toBe('%  %');
    expect(climbNameLikePattern('')).toBe('%%');
  });
});
