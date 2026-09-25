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
    expect(climbNameLikePattern('“Big” one')).toBe('%_Big_ one%');
    expect(climbNameLikePattern('"Big"')).toBe('%_Big_%');
  });

  it('turns every hyphen and dash variant into a one-character wildcard', () => {
    expect(climbNameLikePattern('Spider-Man')).toBe('%Spider_Man%');
    expect(climbNameLikePattern('Spider–Man')).toBe('%Spider_Man%');
    expect(climbNameLikePattern('Spider—Man')).toBe('%Spider_Man%');
  });

  // Folding spaces to `%` let `the end` match "the … end" with any words between,
  // pushing the climb actually named "The End" off the first page (#5655 review).
  it('keeps spaces literal, so words cannot drift apart', () => {
    expect(climbNameLikePattern('Joey’s Gaston')).toBe('%Joey_s Gaston%');
    expect(climbNameLikePattern('the end')).toBe('%the end%');
    expect(climbNameLikePattern('joey  gaston')).toBe('%joey  gaston%');
  });

  it("still escapes the user's own LIKE metacharacters", () => {
    expect(climbNameLikePattern('50%')).toBe('%50\\%%');
    expect(climbNameLikePattern('a_b')).toBe('%a\\_b%');
    expect(climbNameLikePattern('back\\slash')).toBe('%back\\\\slash%');
  });

  // An all-wildcard `%_%` would match every climb and leak the by-name exceptions
  // (hidden climbs, Woods cross-angle) into an unfiltered list, so a query the
  // folds would empty keeps the old literal pattern.
  it('keeps whitespace-only input literal instead of matching every climb', () => {
    expect(climbNameLikePattern('  ')).toBe('%  %');
    expect(climbNameLikePattern('')).toBe('%%');
  });

  it('keeps punctuation-only input literal instead of matching every climb', () => {
    expect(climbNameLikePattern("'")).toBe("%'%");
    expect(climbNameLikePattern('-')).toBe('%-%');
    expect(climbNameLikePattern('“')).toBe('%“%');
    expect(climbNameLikePattern("' '")).toBe("%' '%");
    expect(climbNameLikePattern('- -')).toBe('%- -%');
  });
});
