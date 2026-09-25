import { describe, it, expect } from 'vitest';
import {
  boardPlaceLabel,
  boardConfigLabel,
  boardRowSubtitle,
  disambiguateBoardSubtitles,
  stripGymNamePrefix,
  type BoardLabelSource,
} from '../board-labels';

// Kilter layout 1 is "Kilter Board Original"; size 7 is "12 x 14" and size 8 is
// "8 x 12" in the bundled @boardsesh/board-constants tables.
const kilter: BoardLabelSource = {
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 7,
  gymName: null,
  locationName: null,
  angle: 40,
  serialNumber: null,
};

describe('boardPlaceLabel', () => {
  it('prefers the linked gym over the free-text location', () => {
    expect(boardPlaceLabel({ ...kilter, gymName: 'Bergen Klatresenter', locationName: 'Bergen' })).toBe(
      'Bergen Klatresenter',
    );
  });

  it('falls back to the free-text location', () => {
    expect(boardPlaceLabel({ ...kilter, locationName: 'Danmarksplass' })).toBe('Danmarksplass');
  });

  it('is null when the board has neither', () => {
    expect(boardPlaceLabel(kilter)).toBeNull();
  });

  it('treats a blank string from the API as absent', () => {
    expect(boardPlaceLabel({ ...kilter, gymName: '   ', locationName: 'Bergen' })).toBe('Bergen');
  });

  // Both candidates are gym-level, not wall-level: gymName is shared by every
  // row, and the wall crawl writes locationName as the gym's "<city>, <country>"
  // for every wall it imports. Leading with either collides every row.
  it('has no place label within one gym', () => {
    const board = { ...kilter, gymName: 'Bergen Klatresenter', locationName: 'Bergen, Norway' };
    expect(boardPlaceLabel(board, { scope: 'within-gym' })).toBeNull();
  });

  it('still reads the gym, then the city, globally', () => {
    const board = { ...kilter, gymName: 'Bergen Klatresenter', locationName: 'Bergen, Norway' };
    expect(boardPlaceLabel(board)).toBe('Bergen Klatresenter');
    expect(boardPlaceLabel({ ...kilter, locationName: 'Bergen, Norway' })).toBe('Bergen, Norway');
  });
});

describe('boardConfigLabel', () => {
  it('resolves layout and size names from the bundled tables', () => {
    expect(boardConfigLabel(kilter)).toBe('Original 12×14');
  });

  it('keeps the layout when the size id is unknown — never renders the raw id', () => {
    expect(boardConfigLabel({ ...kilter, sizeId: 99999 })).toBe('Original');
  });

  it('is null when the board type is not one the bundled tables know', () => {
    expect(boardConfigLabel({ ...kilter, boardType: 'not-a-board' })).toBeNull();
  });

  it('is null when neither layout nor size resolves', () => {
    expect(boardConfigLabel({ ...kilter, layoutId: 99999, sizeId: 99999 })).toBeNull();
  });
});

describe('boardRowSubtitle', () => {
  it('shows where the board is when it has a place', () => {
    expect(boardRowSubtitle({ ...kilter, gymName: 'Bergen Klatresenter' })).toBe('Bergen Klatresenter');
  });

  it('falls back to what the board is', () => {
    expect(boardRowSubtitle(kilter)).toBe('Original 12×14');
  });

  it('falls back to the brand name, never the raw lowercase board type', () => {
    expect(boardRowSubtitle({ ...kilter, layoutId: 99999, sizeId: 99999 })).toBe('Kilter');
  });

  it('shows what the board is instead of the gym within one gym', () => {
    const board = { ...kilter, gymName: 'Bergen Klatresenter' };
    expect(boardRowSubtitle(board, { scope: 'within-gym' })).toBe('Original 12×14');
  });
});

describe('disambiguateBoardSubtitles', () => {
  it('leaves boards with distinct subtitles alone', () => {
    const boards: BoardLabelSource[] = [
      { ...kilter, gymName: 'Bergen Klatresenter' },
      { ...kilter, gymName: 'Åsane Klatresenter' },
    ];
    expect(disambiguateBoardSubtitles(boards)).toEqual(['Bergen Klatresenter', 'Åsane Klatresenter']);
  });

  it('separates two same-gym boards on the first facet that differs (size)', () => {
    // The reported case: two Kilters, same operator, different walls.
    const boards: BoardLabelSource[] = [
      { ...kilter, gymName: 'Bergen Klatresenter', sizeId: 7 },
      { ...kilter, gymName: 'Bergen Klatresenter', sizeId: 8 },
    ];
    expect(disambiguateBoardSubtitles(boards)).toEqual(['Bergen Klatresenter · 12×14', 'Bergen Klatresenter · 8×12']);
  });

  it('falls through to the layout when the size matches', () => {
    const boards: BoardLabelSource[] = [
      { boardType: 'tension', layoutId: 10, sizeId: 6, gymName: 'Klatreverket', angle: 40 },
      { boardType: 'tension', layoutId: 11, sizeId: 6, gymName: 'Klatreverket', angle: 40 },
    ];
    const [first, second] = disambiguateBoardSubtitles(boards);
    expect(first).toBe('Klatreverket · Mirror');
    expect(second).toBe('Klatreverket · Spray');
  });

  it('falls through to the angle when the config matches', () => {
    const boards: BoardLabelSource[] = [
      { ...kilter, gymName: 'Bergen Klatresenter', angle: 40 },
      { ...kilter, gymName: 'Bergen Klatresenter', angle: 25 },
    ];
    expect(disambiguateBoardSubtitles(boards)).toEqual(['Bergen Klatresenter · 40°', 'Bergen Klatresenter · 25°']);
  });

  it('falls through to the serial tail when everything else matches', () => {
    const boards: BoardLabelSource[] = [
      { ...kilter, gymName: 'Bergen Klatresenter', serialNumber: 'KL-00081234' },
      { ...kilter, gymName: 'Bergen Klatresenter', serialNumber: 'KL-00085678' },
    ];
    expect(disambiguateBoardSubtitles(boards)).toEqual(['Bergen Klatresenter · 1234', 'Bergen Klatresenter · 5678']);
  });

  it('leaves genuinely indistinguishable boards untouched — no invented distinction', () => {
    const boards: BoardLabelSource[] = [
      { ...kilter, gymName: 'Bergen Klatresenter' },
      { ...kilter, gymName: 'Bergen Klatresenter' },
    ];
    expect(disambiguateBoardSubtitles(boards)).toEqual(['Bergen Klatresenter', 'Bergen Klatresenter']);
  });

  it('appends only to the members that have the facet', () => {
    const boards: BoardLabelSource[] = [
      { ...kilter, gymName: 'Bergen Klatresenter', angle: null },
      { ...kilter, gymName: 'Bergen Klatresenter', angle: 25 },
    ];
    expect(disambiguateBoardSubtitles(boards)).toEqual(['Bergen Klatresenter', 'Bergen Klatresenter · 25°']);
  });

  it('scopes disambiguation to the colliding group only', () => {
    const boards: BoardLabelSource[] = [
      { ...kilter, gymName: 'Bergen Klatresenter', sizeId: 7 },
      { ...kilter, gymName: 'Bergen Klatresenter', sizeId: 8 },
      { ...kilter, gymName: 'Åsane Klatresenter', sizeId: 7 },
    ];
    expect(disambiguateBoardSubtitles(boards)).toEqual([
      'Bergen Klatresenter · 12×14',
      'Bergen Klatresenter · 8×12',
      'Åsane Klatresenter',
    ]);
  });

  it('prefers a facet that separates every member over one that only splits the group', () => {
    // Three boards at one gym: two share a size, so the size facet would leave
    // two cards reading the same. The angle facet separates all three.
    const boards: BoardLabelSource[] = [
      { ...kilter, gymName: 'Bergen Klatresenter', sizeId: 7, angle: 40 },
      { ...kilter, gymName: 'Bergen Klatresenter', sizeId: 7, angle: 25 },
      { ...kilter, gymName: 'Bergen Klatresenter', sizeId: 8, angle: 55 },
    ];
    expect(disambiguateBoardSubtitles(boards)).toEqual([
      'Bergen Klatresenter · 40°',
      'Bergen Klatresenter · 25°',
      'Bergen Klatresenter · 55°',
    ]);
  });

  it('falls back to a partial split when no single facet separates everyone', () => {
    // Two boards are identical on every facet — nothing can separate those two,
    // but the third still gets pulled out on size.
    const boards: BoardLabelSource[] = [
      { ...kilter, gymName: 'Bergen Klatresenter', sizeId: 7 },
      { ...kilter, gymName: 'Bergen Klatresenter', sizeId: 7 },
      { ...kilter, gymName: 'Bergen Klatresenter', sizeId: 8 },
    ];
    expect(disambiguateBoardSubtitles(boards)).toEqual([
      'Bergen Klatresenter · 12×14',
      'Bergen Klatresenter · 12×14',
      'Bergen Klatresenter · 8×12',
    ]);
  });

  it('handles an empty list', () => {
    expect(disambiguateBoardSubtitles([])).toEqual([]);
  });
});

describe('disambiguateBoardSubtitles, scope within-gym', () => {
  // Neither candidate place label is worth leading with inside one gym. The gym
  // name is shared by every row by definition, and locationName is written by
  // the wall crawl as "<city>, <country>" for every wall at the gym — so both
  // put identical words on every row and collide them all before a single facet
  // has been tried. What the board IS leads instead.
  const atOneGym = { ...kilter, gymName: 'Bergen Klatresenter', locationName: 'Bergen, Norway' };

  it('leads with what the board is, never the gym or its city', () => {
    const subtitles = disambiguateBoardSubtitles([atOneGym], { scope: 'within-gym' });
    expect(subtitles[0]).not.toContain('Bergen Klatresenter');
    expect(subtitles[0]).not.toContain('Bergen, Norway');
    expect(subtitles[0]).toBe('Original 12×14');
  });

  it('separates three boards at one gym on size', () => {
    // Kilter sizes 7/8/13 are 12x14, 8x12 and 10x10, so the config label alone
    // already tells them apart — no facet needed.
    const boards: BoardLabelSource[] = [
      { ...atOneGym, sizeId: 7 },
      { ...atOneGym, sizeId: 8 },
      { ...atOneGym, sizeId: 13 },
    ];
    expect(disambiguateBoardSubtitles(boards, { scope: 'within-gym' })).toEqual([
      'Original 12×14',
      'Original 8×12',
      'Original 10×10',
    ]);
  });

  it('separates three boards sharing a config on angle', () => {
    const boards: BoardLabelSource[] = [
      { ...atOneGym, angle: 25 },
      { ...atOneGym, angle: 40 },
      { ...atOneGym, angle: 55 },
    ];
    expect(disambiguateBoardSubtitles(boards, { scope: 'within-gym' })).toEqual([
      'Original 12×14 · 25°',
      'Original 12×14 · 40°',
      'Original 12×14 · 55°',
    ]);
  });

  // The #5272 case: two walls the crawl named identically, same board, same
  // angle. The serial is the last thing that can tell them apart, and it is
  // printed on the controller box so a climber can check it.
  it('falls through to the serial for two identically configured walls', () => {
    const boards: BoardLabelSource[] = [
      { ...atOneGym, serialNumber: 'KB-0000A3F1' },
      { ...atOneGym, serialNumber: 'KB-00007C09' },
    ];
    const subtitles = disambiguateBoardSubtitles(boards, { scope: 'within-gym' });
    expect(subtitles[0]).not.toBe(subtitles[1]);
    expect(subtitles[0]).toContain('A3F1');
    expect(subtitles[1]).toContain('7C09');
  });

  it('leaves two boards identical on every facet alone', () => {
    const boards: BoardLabelSource[] = [atOneGym, { ...atOneGym }];
    const subtitles = disambiguateBoardSubtitles(boards, { scope: 'within-gym' });
    expect(subtitles[0]).toBe(subtitles[1]);
  });

  it('never leaks the gym city that global would have used', () => {
    const boards: BoardLabelSource[] = [
      { ...kilter, locationName: 'Bergen, Norway', sizeId: 7 },
      { ...kilter, locationName: 'Bergen, Norway', sizeId: 8 },
    ];
    const withinGym = disambiguateBoardSubtitles(boards, { scope: 'within-gym' });
    expect(withinGym.every((subtitle) => !subtitle.includes('Bergen'))).toBe(true);
    expect(disambiguateBoardSubtitles(boards)[0]).toContain('Bergen');
  });
});

describe('stripGymNamePrefix', () => {
  it('drops a hyphenated gym prefix', () => {
    expect(stripGymNamePrefix('Bergen Klatresenter - Kilter', 'Bergen Klatresenter')).toBe('Kilter');
  });

  it('drops an en-dashed gym prefix', () => {
    expect(stripGymNamePrefix('Bergen Klatresenter – Kilter', 'Bergen Klatresenter')).toBe('Kilter');
  });

  it('matches the gym name case-insensitively', () => {
    expect(stripGymNamePrefix('BERGEN KLATRESENTER - Tension', 'Bergen Klatresenter')).toBe('Tension');
  });

  it('treats a gym name with regex metacharacters literally', () => {
    expect(stripGymNamePrefix('Klatring (Bergen) - Kilter', 'Klatring (Bergen)')).toBe('Kilter');
    expect(stripGymNamePrefix('Klatring xBergeny - Kilter', 'Klatring (Bergen)')).toBe('Klatring xBergeny - Kilter');
  });

  it('leaves a name that only mentions the gym mid-string alone', () => {
    expect(stripGymNamePrefix('Kilter at Bergen Klatresenter', 'Bergen Klatresenter')).toBe(
      'Kilter at Bergen Klatresenter',
    );
  });

  it('leaves the name alone when stripping would empty it', () => {
    expect(stripGymNamePrefix('Bergen Klatresenter -', 'Bergen Klatresenter')).toBe('Bergen Klatresenter -');
  });

  it('leaves the name alone when there is no gym', () => {
    expect(stripGymNamePrefix('Bergen Klatresenter - Kilter', null)).toBe('Bergen Klatresenter - Kilter');
  });
});

// A spray wall is a climber's own wall: its layout row is created at runtime, so
// neither the layout nor the size facet can name it, and the row title is a name
// the owner chose ("Garage", "Main wall") that says nothing about what it is.
describe('boardRowSubtitle on a spray wall', () => {
  const wall: BoardLabelSource = { boardType: 'spray', layoutId: 941, sizeId: 941 };

  it('leads with what it is when there is no place', () => {
    expect(boardRowSubtitle(wall)).toBe('Spray wall');
  });

  it('keeps the kind in front of the gym', () => {
    expect(boardRowSubtitle({ ...wall, gymName: 'Bergen Klatresenter' })).toBe('Spray wall · Bergen Klatresenter');
  });

  it('falls back to the free-text location the way every other board does', () => {
    expect(boardRowSubtitle({ ...wall, locationName: 'Garage' })).toBe('Spray wall · Garage');
  });

  // Inside one gym's list the place is dropped as redundant — but the KIND is
  // exactly what tells the wall apart from the gym's Kilter on the row above, so
  // that is what survives.
  it('drops the place but keeps the kind within a gym', () => {
    expect(boardRowSubtitle({ ...wall, gymName: 'Bergen Klatresenter' }, { scope: 'within-gym' })).toBe('Spray wall');
  });

  it('never shows a catalogue config for a wall', () => {
    expect(boardConfigLabel(wall)).toBeNull();
  });

  // Two of one climber's walls collide on "Spray wall" and separate on a facet
  // that a wall actually has — never on a layout or size name it does not.
  it('separates two walls at the same gym on their angle', () => {
    const subtitles = disambiguateBoardSubtitles([
      { ...wall, layoutId: 941, sizeId: 941, angle: 40 },
      { ...wall, layoutId: 942, sizeId: 942, angle: 25 },
    ]);
    expect(subtitles).toEqual(['Spray wall · 40°', 'Spray wall · 25°']);
  });
});
