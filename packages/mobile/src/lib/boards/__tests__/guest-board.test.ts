import { describe, expect, it } from 'vitest';
import { createGuestActiveBoard, GUEST_BOARD_UUID_PREFIX, isGuestActiveBoard } from '../guest-board';

describe('guest active boards', () => {
  it('builds a stable local UserBoard from a board config', () => {
    const board = createGuestActiveBoard({
      boardName: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '4,2,4',
      angle: 40,
      displayName: 'Guest setup',
    });

    expect(board.uuid).toBe(`${GUEST_BOARD_UUID_PREFIX}kilter:1:10:2,4`);
    expect(board.slug).toBe('guest-kilter-1-10-2-4');
    expect(board.setIds).toBe('2,4');
    expect(board.name).toBe('Guest setup');
    expect(board.ownerId).toBe('');
    expect(board.isOwned).toBe(false);
    expect(board.serialNumber).toBeNull();
    expect(isGuestActiveBoard(board)).toBe(true);
  });

  it('does not treat normal server boards as guest boards', () => {
    expect(isGuestActiveBoard({ uuid: '11111111-1111-4111-8111-111111111111' })).toBe(false);
    expect(isGuestActiveBoard(null)).toBe(false);
  });
});
