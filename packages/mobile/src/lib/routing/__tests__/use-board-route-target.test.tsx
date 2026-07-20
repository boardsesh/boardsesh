// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardRouteTarget } from '../board-route-target';

const router = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => true), push: vi.fn() }));
const openPlayDrawer = vi.hoisted(() => vi.fn());
const openClimbInPlayDrawer = vi.hoisted(() => vi.fn());
const setActiveBoard = vi.hoisted(() => vi.fn(async () => {}));
const resolveBoardForSession = vi.hoisted(() => vi.fn());
const refetchMyBoards = vi.hoisted(() => vi.fn());
// Mutable so each test seeds the climb query it wants without re-mocking.
const climbQuery = vi.hoisted(() => ({
  current: { data: undefined, isError: false, isSuccess: false } as {
    data?: { uuid: string };
    isError: boolean;
    isSuccess: boolean;
  },
}));
const myBoardsQuery = vi.hoisted(() => ({
  current: { data: { boards: [] as UserBoard[] }, refetch: refetchMyBoards } as {
    data?: { boards: UserBoard[] };
    refetch: typeof refetchMyBoards;
  },
}));

vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('../../graphql/hooks', () => ({
  useClimb: (variables: unknown) =>
    variables ? climbQuery.current : { data: undefined, isError: false, isSuccess: false },
  useMyBoards: () => myBoardsQuery.current,
  useCreateBoard: () => ({ mutateAsync: vi.fn() }),
  fetchBoardBySlug: vi.fn(),
}));
vi.mock('../../graphql/use-active-board', () => ({ useSetActiveBoard: () => setActiveBoard }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ openPlayDrawer }) }));
vi.mock('../../board-path-to-user-board', () => ({ resolveBoardForSession }));
vi.mock('../../open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer }));

const { useBoardRouteTarget } = await import('../use-board-route-target');

const CLIMB_UUID = '0A1B2C3D4E5F60718293A4B5C6D7E8F9';
const OTHER_CLIMB_UUID = 'F9E8D7C6B5A4938271605F4E3D2C1B0A';
const KILTER_BOARD = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
const RESOLVED_BOARD = {
  uuid: 'board-uuid',
  boardType: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1,20',
  angle: 40,
} as unknown as UserBoard;

function Harness({ target, mode }: { target: BoardRouteTarget | null; mode?: 'deep-link' | 'in-app' }) {
  return createElement('span', { 'data-status': useBoardRouteTarget(target, { mode }) });
}

function statusOf(container: HTMLElement): string | null {
  return container.querySelector('span')?.getAttribute('data-status') ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  router.canGoBack.mockReturnValue(true);
  resolveBoardForSession.mockResolvedValue(RESOLVED_BOARD);
  climbQuery.current = { data: undefined, isError: false, isSuccess: false };
  myBoardsQuery.current = { data: { boards: [] }, refetch: refetchMyBoards };
});

describe('useBoardRouteTarget', () => {
  it('adopts the URL board and lands on the climbs tab for a list URL', async () => {
    const { container } = render(
      createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }),
    );

    expect(statusOf(container)).toBe('resolving');
    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledWith(RESOLVED_BOARD));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs'));
    expect(resolveBoardForSession).toHaveBeenCalledWith('kilter/1/10/1,20/40', expect.anything());
  });

  it('opens a deep-linked climb as a preview so a session queue is left alone', async () => {
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };

    render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(openClimbInPlayDrawer).toHaveBeenCalledTimes(1));
    expect(openClimbInPlayDrawer).toHaveBeenCalledWith(
      { kind: 'climb', climb: { uuid: CLIMB_UUID }, boardConfig: KILTER_BOARD },
      expect.anything(),
      { preview: true },
    );
  });

  // A second URL through the same mounted screen is what the web build does when
  // a user taps a link to another climb: the route component is reused, so a
  // once-per-mount hand-off guard would leave them on the spinner.
  it('hands off again when a new target arrives on the same mounted screen', async () => {
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };
    const { rerender } = render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );
    await waitFor(() => expect(openClimbInPlayDrawer).toHaveBeenCalledTimes(1));

    climbQuery.current = { data: { uuid: OTHER_CLIMB_UUID }, isError: false, isSuccess: true };
    rerender(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: OTHER_CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(openClimbInPlayDrawer).toHaveBeenCalledTimes(2));
    expect(openClimbInPlayDrawer.mock.calls[1][0]).toMatchObject({ climb: { uuid: OTHER_CLIMB_UUID } });
  });

  it('is not found when the URL did not parse', () => {
    const { container } = render(createElement(Harness, { target: null }));
    expect(statusOf(container)).toBe('not-found');
  });

  it('is not found when the board cannot be resolved', async () => {
    resolveBoardForSession.mockRejectedValue(new Error('dead slug'));

    const { container } = render(
      createElement(Harness, { target: { kind: 'slug-list', slug: 'gone', angle: null } as BoardRouteTarget }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('not-found'));
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('stays on the spinner while the climb query is still settling', async () => {
    const { container } = render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(setActiveBoard).toHaveBeenCalled());
    expect(statusOf(container)).toBe('resolving');
    expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
  });

  it('is not found once the climb query says the climb is gone', async () => {
    climbQuery.current = { data: undefined, isError: false, isSuccess: true };

    const { container } = render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('not-found'));
  });

  // The in-app `ref` push carries a config the app already had; adopting it would
  // switch (or mint) a board just because the user tapped someone else's tick.
  it('leaves the active board alone and pops back for an in-app target', async () => {
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };

    render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
        mode: 'in-app',
      }),
    );

    await waitFor(() => expect(openClimbInPlayDrawer).toHaveBeenCalledTimes(1));
    expect(resolveBoardForSession).not.toHaveBeenCalled();
    expect(setActiveBoard).not.toHaveBeenCalled();
    expect(router.back).toHaveBeenCalled();
  });

  it('does not mint a duplicate board when the owned-board list could not be loaded', async () => {
    myBoardsQuery.current = { data: undefined, refetch: refetchMyBoards };
    refetchMyBoards.mockResolvedValue({ data: undefined });

    const { container } = render(
      createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('not-found'));
    expect(resolveBoardForSession).not.toHaveBeenCalled();
  });
});
