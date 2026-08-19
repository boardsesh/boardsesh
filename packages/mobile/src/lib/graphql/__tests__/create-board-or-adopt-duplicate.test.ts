import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CreateBoardInput, UserBoard } from '@boardsesh/shared-schema';

const fetchBoardByUuid = vi.hoisted(() => vi.fn());

vi.mock('../hooks', () => ({ fetchBoardByUuid }));

import { createBoardOrAdoptDuplicate } from '../create-board-or-adopt-duplicate';

function makeBoard(overrides: Partial<UserBoard> = {}): UserBoard {
  return {
    uuid: 'board-uuid',
    boardType: 'kilter',
    layoutId: 8,
    sizeId: 17,
    setIds: '27,28',
    name: 'Kilter',
    angle: 40,
    isOwned: false,
    isAngleAdjustable: true,
    ...overrides,
  } as unknown as UserBoard;
}

const CREATE_INPUT: CreateBoardInput = {
  boardType: 'kilter',
  layoutId: 8,
  sizeId: 17,
  setIds: '27,28',
  angle: 30,
  isOwned: false,
  name: 'Kilter',
};

/** The BOARD_DUPLICATE_CONFIG shape graphql-request throws, as the backend sends it. */
function duplicateRejection(existingBoardUuid: string) {
  return {
    response: {
      errors: [
        { message: 'You already have this board', extensions: { code: 'BOARD_DUPLICATE_CONFIG', existingBoardUuid } },
      ],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchBoardByUuid.mockResolvedValue(null);
});

describe('createBoardOrAdoptDuplicate', () => {
  it('returns the created board when the server accepts the create', async () => {
    const created = makeBoard({ uuid: 'fresh-uuid', angle: 30 });
    const createBoard = vi.fn().mockResolvedValue(created);

    await expect(createBoardOrAdoptDuplicate(CREATE_INPUT, createBoard)).resolves.toBe(created);
    expect(createBoard).toHaveBeenCalledWith(CREATE_INPUT);
    expect(fetchBoardByUuid).not.toHaveBeenCalled();
  });

  it('adopts the board a duplicate rejection names, at the input angle', async () => {
    const existing = makeBoard({ uuid: 'existing-uuid', angle: 40 });
    fetchBoardByUuid.mockResolvedValue(existing);
    const createBoard = vi.fn().mockRejectedValue(duplicateRejection('existing-uuid'));

    const result = await createBoardOrAdoptDuplicate(CREATE_INPUT, createBoard);

    expect(fetchBoardByUuid).toHaveBeenCalledWith('existing-uuid');
    expect(result).toEqual({ ...existing, angle: 30 });
    // The cached board must not be mutated in place.
    expect(existing.angle).toBe(40);
  });

  it('returns the same reference when the existing board is already at the input angle', async () => {
    const existing = makeBoard({ uuid: 'existing-uuid', angle: 30 });
    fetchBoardByUuid.mockResolvedValue(existing);
    const createBoard = vi.fn().mockRejectedValue(duplicateRejection('existing-uuid'));

    await expect(createBoardOrAdoptDuplicate(CREATE_INPUT, createBoard)).resolves.toBe(existing);
  });

  it("falls back to the existing board's own angle when the input carries none", async () => {
    const existing = makeBoard({ uuid: 'existing-uuid', angle: 45 });
    fetchBoardByUuid.mockResolvedValue(existing);
    const createBoard = vi.fn().mockRejectedValue(duplicateRejection('existing-uuid'));

    const result = await createBoardOrAdoptDuplicate({ ...CREATE_INPUT, angle: undefined }, createBoard);

    expect(result).toBe(existing);
  });

  it('rethrows a rejection that is not a duplicate', async () => {
    const createBoard = vi.fn().mockRejectedValue(new Error('Network request failed'));

    await expect(createBoardOrAdoptDuplicate(CREATE_INPUT, createBoard)).rejects.toThrow(/Network request failed/);
    expect(fetchBoardByUuid).not.toHaveBeenCalled();
  });

  it('rethrows the create rejection when the named board cannot be read', async () => {
    fetchBoardByUuid.mockResolvedValue(null);
    const rejection = duplicateRejection('existing-uuid');
    const createBoard = vi.fn().mockRejectedValue(rejection);

    await expect(createBoardOrAdoptDuplicate(CREATE_INPUT, createBoard)).rejects.toBe(rejection);
  });

  it('rethrows the create rejection when the lookup itself fails', async () => {
    fetchBoardByUuid.mockRejectedValue(new Error('lookup exploded'));
    const rejection = duplicateRejection('existing-uuid');
    const createBoard = vi.fn().mockRejectedValue(rejection);

    // The create rejection is the failure that describes what happened, so the
    // lookup's own rejection is swallowed rather than replacing it.
    await expect(createBoardOrAdoptDuplicate(CREATE_INPUT, createBoard)).rejects.toBe(rejection);
  });
});
