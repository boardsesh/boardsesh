// @vitest-environment jsdom
//
// "Use this board" (#8151): follow first, unless the wall is already the
// climber's, then bind. A failed follow must never leave a wall active that
// won't be in their list tomorrow.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UserBoard } from '@boardsesh/shared-schema';

const followMock = vi.hoisted(() => vi.fn());
const activateMock = vi.hoisted(() => vi.fn());
const activateOptions = vi.hoisted(() => ({ last: null as unknown }));
const undoSecuredMock = vi.hoisted(() => vi.fn());
const securedMock = vi.hoisted(() => vi.fn(() => undoSecuredMock));

vi.mock('../../graphql/hooks', () => ({ useFollowBoard: () => ({ mutateAsync: followMock }) }));
vi.mock('../use-activate-board', () => ({
  useActivateBoard: (options: unknown) => {
    activateOptions.last = options;
    return activateMock;
  },
}));
vi.mock('../board-create-flow', () => ({ noteBoardFlowSecured: securedMock }));
vi.mock('@boardsesh/board-config', () => ({ boardSetupLabelParts: vi.fn(), toBoardName: vi.fn() }));
vi.mock('../../../components/board-discovery/board-builder-labels', () => ({ boardTypeLabel: vi.fn() }));

const { useTakeExistingWall } = await import('../use-take-existing-wall');

const wall = { uuid: 'wall-1', name: 'Gym wall', ownerId: 'someone', isFollowedByMe: false } as UserBoard;

beforeEach(() => {
  vi.clearAllMocks();
  securedMock.mockImplementation(() => undoSecuredMock);
  followMock.mockResolvedValue(undefined);
  activateMock.mockResolvedValue(undefined);
});

function take(viewerId: string | null, source?: string) {
  const { result } = renderHook(() => useTakeExistingWall({ returnTo: '/(tabs)/climbs', source, viewerId }));
  return result.current;
}

describe('useTakeExistingWall', () => {
  it("follows someone else's wall, then binds it as a gym-finder pick", async () => {
    await expect(take('viewer')(wall)).resolves.toEqual({ alreadyFollowed: false });
    expect(followMock).toHaveBeenCalledWith(wall);
    expect(activateMock).toHaveBeenCalledWith(wall, { pickSource: 'gym_finder' });
    expect(followMock.mock.invocationCallOrder[0]).toBeLessThan(activateMock.mock.invocationCallOrder[0] ?? 0);
    expect(securedMock).toHaveBeenCalled();
  });

  it.each([
    { name: 'their own wall', board: { ...wall, ownerId: 'viewer' } },
    { name: 'a wall they follow', board: { ...wall, isFollowedByMe: true } },
  ])('just binds $name', async ({ board }) => {
    await expect(take('viewer')(board)).resolves.toEqual({ alreadyFollowed: true });
    expect(followMock).not.toHaveBeenCalled();
    expect(activateMock).toHaveBeenCalledWith(board, { pickSource: 'gym_finder' });
  });

  it('binds nothing when the follow fails', async () => {
    followMock.mockRejectedValueOnce(new Error('follow failed'));
    await expect(take('viewer')(wall)).rejects.toThrow('follow failed');
    expect(activateMock).not.toHaveBeenCalled();
    expect(securedMock).not.toHaveBeenCalled();
  });

  it('takes back the secured mark when the bind fails, so leaving still counts', async () => {
    activateMock.mockRejectedValueOnce(new Error('storage full'));
    await expect(take('viewer')(wall)).rejects.toThrow('storage full');
    expect(securedMock).toHaveBeenCalled();
    expect(undoSecuredMock).toHaveBeenCalled();
  });

  it('closes out first run from an onboarding picker, and rethrows a failed bind', () => {
    take('viewer', 'onboarding');
    expect(activateOptions.last).toMatchObject({
      source: 'onboarding',
      returnTo: '/(tabs)/climbs',
      writeFailure: 'rethrow',
    });
    take('viewer', 'no_board');
    expect(activateOptions.last).toMatchObject({ source: undefined });
  });
});
