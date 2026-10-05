import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const fixture = vi.hoisted(() => ({
  boardType: 'spray',
  ownerId: 'wall-owner',
  deleteWall: vi.fn(async () => true),
  previewTombstone: vi.fn(async () => {}),
  updateBoard: vi.fn(),
}));
vi.mock('../db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: 31,
              ownerId: fixture.ownerId,
              boardType: fixture.boardType,
              isPublic: true,
            },
          ],
        }),
      }),
    }),
    update: () => ({ set: fixture.updateBoard.mockImplementation(() => ({ where: async () => {} })) }),
  },
}));
vi.mock('../graphql/resolvers/board/spray-walls', () => ({
  sprayWallMutations: { deleteSprayWall: fixture.deleteWall },
}));
vi.mock('../services/board-queue-preview', () => ({
  publishBoardQueuePreviewTombstoneForBoard: fixture.previewTombstone,
}));
vi.mock('../graphql/resolvers/shared/helpers', () => ({
  requireAuthenticated: vi.fn(),
  applyRateLimit: vi.fn(async () => {}),
  validateInput: (_schema: unknown, input: unknown) => input,
}));

import { socialBoardMutations } from '../graphql/resolvers/social/boards';
const context = { connectionId: 'owner-connection', userId: 'wall-owner', isAuthenticated: true } as ConnectionContext;
const boardUuid = 'b6e35c95-8468-4912-b4ef-2bd80d3f0647';

beforeEach(() => {
  vi.clearAllMocks();
  fixture.boardType = 'spray';
  fixture.ownerId = 'wall-owner';
});

describe('deleting a spray board through the generic picker mutation', () => {
  it('uses wall cleanup and still retracts the public queue preview', async () => {
    expect(await socialBoardMutations.deleteBoard(null, { boardUuid }, context)).toBe(true);
    expect(fixture.deleteWall).toHaveBeenCalledWith(null, { uuid: boardUuid }, context);
    expect(fixture.updateBoard).not.toHaveBeenCalled();
    expect(fixture.previewTombstone).toHaveBeenCalledWith(31);
  });

  it('rejects another owner before wall cleanup runs', async () => {
    fixture.ownerId = 'someone-else';
    await expect(socialBoardMutations.deleteBoard(null, { boardUuid }, context)).rejects.toThrow('Not authorized');
    expect(fixture.deleteWall).not.toHaveBeenCalled();
    expect(fixture.previewTombstone).not.toHaveBeenCalled();
  });

  it('keeps ordinary catalogue board deletion on the generic path', async () => {
    fixture.boardType = 'kilter';
    await socialBoardMutations.deleteBoard(null, { boardUuid }, context);
    expect(fixture.deleteWall).not.toHaveBeenCalled();
    expect(fixture.updateBoard).toHaveBeenCalledWith(
      expect.objectContaining({
        deletedAt: expect.any(Date),
        syncFrozenAt: expect.any(Date),
      }),
    );
  });
});
