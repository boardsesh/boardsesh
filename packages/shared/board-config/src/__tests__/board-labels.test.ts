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

  it('reads the wall label, never the gym, within one gym', () => {
    const board = { ...kilter, gymName: 'Bergen Klatresenter', locationName: 'Main wall' };
    expect(boardPlaceLabel(board, { scope: 'within-gym' })).toBe('Main wall');
  });

  it('has no place within a gym when the wall is unnamed', () => {
    const board = { ...kilter, gymName: 'Bergen Klatresenter' };
    expect(boardPlaceLabel(board, { scope: 'within-gym' })).toBeNull();
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
  // Every board in one gym's list carries the same gymName, so the gym is what
  // has to be dropped rather than what leads â otherwise all three rows read
  // "Bergen Klatresenter" before a single facet has been tried. Sharing a wall
  // label on top of that is the worst case: the base subtitle collides too.
  const mainWall = { ...kilter, gymName: 'Bergen Klatresenter', locationName: 'Main wall' };

  it('leads with the wall label instead of the gym', () => {
    const boards: BoardLabelSource[] = [mainWall, { ...mainWall, locationName: 'Training room' }];
    expect(disambiguateBoardSubtitles(boards, { scope: 'within-gym' })).toEqual(['Main wall', 'Training room']);
  });

  it('separates three boards sharing a wall on size', () => {
    // Kilter sizes 7/8/13 are 12x14, 8x12 and 10x10.
    const boards: BoardLabelSource[] = [
      { ...mainWall, sizeId: 7 },
      { ...mainWall, sizeId: 8 },
      { ...mainWall, sizeId: 13 },
    ];
    expect(disambiguateBoardSubtitles(boards, { scope: 'within-gym' })).toEqual([
      'Main wall · 12×14',
      'Main wall · 8×12',
      'Main wall · 10×10',
    ]);
  });

  it('separates three boards sharing a wall on layout', () => {
    // Tension layouts 9/10/11 on the one size 6: identical dimensions, so the
    // size facet splits nothing and the layout is what tells them apart.
    const tensionAtMainWall = {
      boardType: 'tension',
      sizeId: 6,
      gymName: 'Bergen Klatresenter',
      locationName: 'Main wall',
      angle: 40,
    };
    const boards: BoardLabelSource[] = [
      { ...tensionAtMainWall, layoutId: 9 },
      { ...tensionAtMainWall, layoutId: 10 },
      { ...tensionAtMainWall, layoutId: 11 },
    ];
    expect(disambiguateBoardSubtitles(boards, { scope: 'within-gym' })).toEqual([
      'Main wall · Original',
      'Main wall · Mirror',
      'Main wall · Spray',
    ]);
  });

  it('separates three boards sharing a wall and a config on angle', () => {
    const boards: BoardLabelSource[] = [
      { ...mainWall, angle: 25 },
      { ...mainWall, angle: 40 },
      { ...mainWall, angle: 55 },
    ];
    expect(disambiguateBoardSubtitles(boards, { scope: 'within-gym' })).toEqual([
      'Main wall · 25°',
      'Main wall · 40°',
      'Main wall · 55°',
    ]);
  });

  it('leaves two boards identical on every facet alone', () => {
    const boards: BoardLabelSource[] = [mainWall, { ...mainWall }];
    expect(disambiguateBoardSubtitles(boards, { scope: 'within-gym' })).toEqual(['Main wall', 'Main wall']);
  });

  it('matches global exactly when no board carries a gym', () => {
    const boards: BoardLabelSource[] = [
      { ...kilter, locationName: 'Danmarksplass', sizeId: 7 },
      { ...kilter, locationName: 'Danmarksplass', sizeId: 8 },
    ];
    expect(disambiguateBoardSubtitles(boards, { scope: 'within-gym' })).toEqual(disambiguateBoardSubtitles(boards));
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
