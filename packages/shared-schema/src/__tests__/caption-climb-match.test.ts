import { describe, it, expect } from 'vitest';
import { matchClimbsToCaption, extractQuotedClimbNames, type CaptionMatchableClimb } from '../caption-climb-match';

function makeClimb(climbName: string, climbUuid = climbName.toLowerCase().replace(/\s+/g, '-')): CaptionMatchableClimb {
  return { climbName, climbUuid };
}

describe('extractQuotedClimbNames', () => {
  it('pulls the name out of straight double quotes, ignoring text around it', () => {
    expect(extractQuotedClimbNames('Finally sent "Purple Nurple" today 🔥')).toEqual(['Purple Nurple']);
    expect(extractQuotedClimbNames('"Purple Nurple" @ 40° on the Kilter Board. #boardsesh')).toEqual(['Purple Nurple']);
  });

  it('handles curly “smart” quotes (Instagram often substitutes them)', () => {
    expect(extractQuotedClimbNames('crushed “Slab Master” at last')).toEqual(['Slab Master']);
  });

  it('returns every distinct quoted name', () => {
    expect(extractQuotedClimbNames('linked "Crimp City" then "Slab Master"')).toEqual(['Crimp City', 'Slab Master']);
  });

  it('drops too-short quoted fragments and de-dupes by normalized form', () => {
    expect(extractQuotedClimbNames('"up" then "Purple Nurple" and "purple nurple!"')).toEqual(['Purple Nurple']);
  });

  it('returns nothing when the caption has no quotes', () => {
    expect(extractQuotedClimbNames('finally sent Purple Nurple today')).toEqual([]);
    expect(extractQuotedClimbNames('')).toEqual([]);
    expect(extractQuotedClimbNames(null)).toEqual([]);
    expect(extractQuotedClimbNames(undefined)).toEqual([]);
  });
});

describe('matchClimbsToCaption', () => {
  it('matches a climb whose quoted name is in the caption', () => {
    const climbs = [makeClimb('Purple Nurple'), makeClimb('The Crimp Master')];
    const result = matchClimbsToCaption('Finally sent "Purple Nurple" today!', climbs);
    expect(result.map((climb) => climb.climbName)).toEqual(['Purple Nurple']);
  });

  it('ignores diacritics, emoji, and punctuation when comparing the quoted name', () => {
    const climbs = [makeClimb('Café Crux')];
    const result = matchClimbsToCaption('sent “cafe crux” 🔥 @ 40°!!!', climbs);
    expect(result.map((climb) => climb.climbName)).toEqual(['Café Crux']);
  });

  it('matches the full quoted name exactly, not a partial-word substring', () => {
    const climbs = [makeClimb('Crimp'), makeClimb('Crimpy McCrimpface')];
    const result = matchClimbsToCaption('huge send on "Crimpy McCrimpface"', climbs);
    // The shorter "Crimp" must NOT match the quoted "Crimpy McCrimpface".
    expect(result.map((climb) => climb.climbName)).toEqual(['Crimpy McCrimpface']);
  });

  it('ranks the longer (more specific) match first when several names are quoted', () => {
    const climbs = [makeClimb('Slab'), makeClimb('Slab Master')];
    const result = matchClimbsToCaption('"Slab Master" then "Slab"', climbs);
    expect(result.map((climb) => climb.climbName)).toEqual(['Slab Master', 'Slab']);
  });

  it('does not match a climb whose name only appears unquoted in the caption', () => {
    const climbs = [makeClimb('Purple Nurple')];
    expect(matchClimbsToCaption('sent Purple Nurple today', climbs)).toEqual([]);
  });

  it('de-dupes by climb when the same climb was logged more than once', () => {
    const climbs = [makeClimb('Purple Nurple', 'pn-1'), makeClimb('Purple Nurple', 'pn-1')];
    const result = matchClimbsToCaption('"Purple Nurple" again', climbs);
    expect(result).toHaveLength(1);
  });

  it('returns nothing for an empty or quote-less caption', () => {
    const climbs = [makeClimb('Purple Nurple')];
    expect(matchClimbsToCaption('', climbs)).toEqual([]);
    expect(matchClimbsToCaption(null, climbs)).toEqual([]);
    expect(matchClimbsToCaption('no quotes here', climbs)).toEqual([]);
  });

  it('preserves the caller row shape so extra fields survive matching', () => {
    const rows = [
      { climbUuid: 'pn', climbName: 'Purple Nurple', tickUuid: 'tick-1', frames: null },
      { climbUuid: 'cm', climbName: 'The Crimp Master', tickUuid: 'tick-2', frames: null },
    ];
    const result = matchClimbsToCaption('Sent "Purple Nurple"!', rows);
    expect(result).toEqual([{ climbUuid: 'pn', climbName: 'Purple Nurple', tickUuid: 'tick-1', frames: null }]);
  });
});
