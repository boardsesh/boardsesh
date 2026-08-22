import { describe, it, expect } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';
import { getBoardDetailFields, isActiveBoard } from '../board-detail-fields';

const base = {
  uuid: 'b-1',
  name: 'Home Board',
  gymName: null,
  locationName: null,
  setNames: null,
  sizeName: null,
  sizeDescription: null,
} as unknown as UserBoard;

describe('getBoardDetailFields', () => {
  it('prefers gymName for the subLocation', () => {
    const board = { ...base, gymName: 'Boulder World', locationName: 'Berlin' } as UserBoard;
    expect(getBoardDetailFields(board).subLocation).toBe('Boulder World');
  });

  it('falls back to locationName when there is no gym', () => {
    const board = { ...base, gymName: null, locationName: 'Berlin' } as UserBoard;
    expect(getBoardDetailFields(board).subLocation).toBe('Berlin');
  });

  it('leaves subLocation undefined when neither is set', () => {
    expect(getBoardDetailFields(base).subLocation).toBeUndefined();
  });

  it('joins set names with a middot', () => {
    const board = { ...base, setNames: ['Bolt Ons', 'Screw Ons'] } as UserBoard;
    expect(getBoardDetailFields(board).setNames).toBe('Bolt Ons · Screw Ons');
  });

  it('returns an empty string when there are no set names', () => {
    expect(getBoardDetailFields(base).setNames).toBe('');
  });

  it('combines size name and description', () => {
    const board = { ...base, sizeName: '12x12', sizeDescription: 'Home' } as UserBoard;
    expect(getBoardDetailFields(board).sizeText).toBe('12x12 · Home');
  });

  it('uses just the description (no leading middot) when size name is missing', () => {
    const board = { ...base, sizeName: null, sizeDescription: 'Home' } as UserBoard;
    expect(getBoardDetailFields(board).sizeText).toBe('Home');
  });

  it('uses just the size name when there is no description', () => {
    const board = { ...base, sizeName: '12x12', sizeDescription: null } as UserBoard;
    expect(getBoardDetailFields(board).sizeText).toBe('12x12');
  });

  it('leaves sizeText undefined when neither size field is set', () => {
    expect(getBoardDetailFields(base).sizeText).toBeUndefined();
  });
});

describe('isActiveBoard', () => {
  it('is true when the uuid matches the active board', () => {
    expect(isActiveBoard(base, 'b-1')).toBe(true);
  });

  it('is false for a different active board', () => {
    expect(isActiveBoard(base, 'b-2')).toBe(false);
  });

  it('is false when there is no active board', () => {
    expect(isActiveBoard(base, null)).toBe(false);
    expect(isActiveBoard(base, undefined)).toBe(false);
  });
});

describe('getBoardDetailFields size fallback', () => {
  // The server sends sizeName/sizeDescription as null on every board, which left
  // the Size spec row permanently hidden. Resolve it from the bundled tables.
  const kilterBoard = { ...base, boardType: 'kilter', layoutId: 1, sizeId: 7 } as unknown as UserBoard;

  it('resolves the size from the bundled tables when the server sends null', () => {
    expect(getBoardDetailFields(kilterBoard).sizeText).toBe('12 x 14 · Commercial');
  });

  it('still prefers the server values when it does send them', () => {
    const withServerSize = { ...kilterBoard, sizeName: '9 x 9', sizeDescription: 'Custom' } as UserBoard;
    expect(getBoardDetailFields(withServerSize).sizeText).toBe('9 x 9 · Custom');
  });

  it('stays undefined for a board type the bundled tables do not know', () => {
    const unknown = { ...kilterBoard, boardType: 'not-a-board' } as unknown as UserBoard;
    expect(getBoardDetailFields(unknown).sizeText).toBeUndefined();
  });
});
