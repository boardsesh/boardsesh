import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { UserBoard } from '@boardsesh/shared-schema';
import { GET_BOARD } from '../../graphql/operations';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request }) }));

import { activatePublishedSprayWall } from '../activate-published-spray-wall';
import { sprayShareTarget } from '../../../components/board-discovery/spray-detail-rows';

const privateBoard = {
  uuid: 'wall-1',
  slug: 'garage-wall',
  name: 'Garage wall',
  boardType: 'spray',
  angle: 40,
  isPublic: false,
  isUnlisted: false,
} as unknown as UserBoard;

beforeEach(() => {
  request.mockReset();
});

describe('activating a published spray wall', () => {
  it.each(['unlisted', 'public'] as const)(
    'replaces the private snapshot with a shareable %s board',
    async (visibility) => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(['board', privateBoard.uuid], { board: privateBoard });
      queryClient.setQueryData(['myBoards'], { boards: [privateBoard] });
      const publishedBoard = {
        ...privateBoard,
        isPublic: visibility === 'public',
        isUnlisted: visibility === 'unlisted',
      };
      request.mockResolvedValue({ board: publishedBoard });
      const activateBoard = vi.fn(async (board: UserBoard) => {
        queryClient.setQueryData(['activeBoard'], board);
      });

      await activatePublishedSprayWall(queryClient, privateBoard.uuid, activateBoard);

      expect(request).toHaveBeenCalledWith(GET_BOARD, { boardUuid: privateBoard.uuid });
      expect(activateBoard).toHaveBeenCalledWith(publishedBoard);
      expect(sprayShareTarget(queryClient.getQueryData<UserBoard>(['activeBoard']))?.visibility).toBe(visibility);
      expect(queryClient.getQueryData(['board', privateBoard.uuid])).toEqual({ board: publishedBoard });
      expect(queryClient.getQueryState(['myBoards'])?.isInvalidated).toBe(true);
      queryClient.clear();
    },
  );

  it('keeps activation retryable when the fresh board read fails', async () => {
    const queryClient = new QueryClient();
    const activateBoard = vi.fn();
    request.mockRejectedValueOnce(new Error('unreachable')).mockResolvedValueOnce({ board: privateBoard });
    await expect(activatePublishedSprayWall(queryClient, privateBoard.uuid, activateBoard)).rejects.toThrow(
      'unreachable',
    );
    expect(activateBoard).not.toHaveBeenCalled();
    await activatePublishedSprayWall(queryClient, privateBoard.uuid, activateBoard);
    expect(activateBoard).toHaveBeenCalledOnce();
    queryClient.clear();
  });

  it('does not activate a wall that disappeared after publication', async () => {
    const queryClient = new QueryClient();
    request.mockResolvedValue({ board: null });
    const activateBoard = vi.fn();
    await expect(activatePublishedSprayWall(queryClient, privateBoard.uuid, activateBoard)).rejects.toThrow(
      'could not be loaded',
    );
    expect(activateBoard).not.toHaveBeenCalled();
    queryClient.clear();
  });
});
