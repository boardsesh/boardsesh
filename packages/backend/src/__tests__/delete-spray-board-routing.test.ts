import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

const { fixture, boardRow, executor } = vi.hoisted(() => {
  const fixture = {
    boardType: 'spray',
    ownerId: 'wall-owner',
    deleteWall: vi.fn(),
    previewTombstone: vi.fn(async () => {}),
    updateBoard: vi.fn(),
  };
  const boardRow = () => ({
    id: 31,
    uuid: 'b6e35c95-8468-4912-b4ef-2bd80d3f0647',
    ownerId: fixture.ownerId,
    gymId: null,
    boardType: fixture.boardType,
    isPublic: true,
  });
  const executor = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Object.assign(Promise.resolve([boardRow()]), { for: async () => [boardRow()] }),
        }),
      }),
    }),
    update: () => ({ set: fixture.updateBoard.mockImplementation(() => ({ where: async () => {} })) }),
  };
  return { fixture, boardRow, executor };
});
vi.mock('../db/client', () => ({
  db: {
    ...executor,
    transaction: async (callback: (tx: typeof executor) => Promise<void>) => callback(executor),
  },
}));
vi.mock('../services/privacy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/privacy')>()),
  canAccessResource: vi.fn(async () => true),
}));
// No community roles: the delete gate's global-admin branch reads them.
vi.mock('../graphql/resolvers/social/roles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../graphql/resolvers/social/roles')>()),
  getUserCommunityRoles: vi.fn(async () => []),
}));
vi.mock('../graphql/resolvers/board/spray-walls', () => ({
  sprayWallMutations: { deleteSprayWall: fixture.deleteWall },
}));
// Closing the board's directory reports reads tables this fake executor doesn't model.
vi.mock('../graphql/resolvers/social/directory-reports/lifecycle', () => ({
  onBoardDeleted: vi.fn(async () => {}),
  onBoardEdited: vi.fn(async () => {}),
  onBoardModerationEvent: vi.fn(async () => {}),
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
  fixture.deleteWall.mockImplementation(
    async (
      _root: unknown,
      args: { beforeBoardDelete?: (board: ReturnType<typeof boardRow>, tx: typeof executor) => Promise<void> },
    ) => {
      await args.beforeBoardDelete?.(boardRow(), executor);
      return true;
    },
  );
});

describe('deleting a spray board through the generic picker mutation', () => {
  it('uses wall cleanup and still retracts the public queue preview', async () => {
    expect(await socialBoardMutations.deleteBoard(null, { boardUuid }, context)).toBe(true);
    expect(fixture.deleteWall).toHaveBeenCalledWith(
      null,
      { uuid: boardUuid, beforeBoardDelete: expect.any(Function) },
      context,
    );
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
