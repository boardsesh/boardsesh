import { describe, it, expect } from 'vitest';
import {
  boardPlaceLabel,
  boardConfigLabel,
  boardRowSubtitle,
  disambiguateBoardSubtitles,
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

  it('handles an empty list', () => {
    expect(disambiguateBoardSubtitles([])).toEqual([]);
  });
});
