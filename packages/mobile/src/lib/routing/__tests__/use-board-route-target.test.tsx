// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { BoardRouteTarget } from '../board-route-target';

const router = vi.hoisted(() => ({ replace: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => true), push: vi.fn() }));
const openPlayDrawer = vi.hoisted(() => vi.fn());
const openClimbInPlayDrawer = vi.hoisted(() => vi.fn());
const setActiveBoard = vi.hoisted(() => vi.fn(async () => {}));
const resolveBoardForSession = vi.hoisted(() => vi.fn());
const fetchAllMyBoards = vi.hoisted(() => vi.fn());
const fetchBoardByUuid = vi.hoisted(() => vi.fn());
const fetchBoardBySlug = vi.hoisted(() => vi.fn());
const createBoardMutateAsync = vi.hoisted(() => vi.fn());
const getStoredActiveBoard = vi.hoisted(() => vi.fn());
const getOfflineBoards = vi.hoisted(() => vi.fn());
// Mutable so each test seeds the climb query it wants without re-mocking.
const climbQuery = vi.hoisted(() => ({
  current: { data: undefined, isError: false, isSuccess: false } as {
    data?: { uuid: string };
    isError: boolean;
    isSuccess: boolean;
  },
}));
// Mirrors AuthProvider: `isLoading` starts true and the session resolves async.
const authState = vi.hoisted(() => ({ current: { isAuthenticated: true, isLoading: false } }));
// The hook reads connectivity straight off React Query's onlineManager (the
// resolve runs once, so a reactive hook would be the wrong shape) and subscribes
// to it to heal a resolve that failed offline. `goOnline` drives that transition
// the way NetInfo would.
const connectivity = vi.hoisted(() => {
  const listeners = new Set<(online: boolean) => void>();
  return {
    isOnline: true,
    listeners,
    goOnline() {
      this.isOnline = true;
      for (const listener of listeners) listener(true);
    },
  };
});

vi.mock('expo-router', () => ({ useRouter: () => router }));
vi.mock('@tanstack/react-query', () => ({
  onlineManager: {
    isOnline: () => connectivity.isOnline,
    subscribe: (listener: (online: boolean) => void) => {
      connectivity.listeners.add(listener);
      return () => connectivity.listeners.delete(listener);
    },
  },
}));
vi.mock('../../graphql/hooks', () => ({
  useClimb: (variables: unknown) =>
    variables ? climbQuery.current : { data: undefined, isError: false, isSuccess: false },
  useCreateBoard: () => ({ mutateAsync: createBoardMutateAsync }),
  fetchAllMyBoards,
  fetchBoardByUuid,
  fetchBoardBySlug,
}));
vi.mock('../../graphql/use-active-board', () => ({ useSetActiveBoard: () => setActiveBoard }));
vi.mock('../../active-board-store', () => ({ getStoredActiveBoard }));
vi.mock('../../../settings/offline-boards', () => ({ getOfflineBoards }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => authState.current }));
vi.mock('../../../providers/drawer-host-provider', () => ({ useDrawerHost: () => ({ openPlayDrawer }) }));
// Only `resolveBoardForSession` is stubbed — the local-match tests below want the
// real config parser and owned-board matcher, and the tests that assert the
// create/slug paths hand the real resolver back in (see `useRealResolver`).
vi.mock('../../board-path-to-user-board', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../board-path-to-user-board')>()),
  resolveBoardForSession,
}));
vi.mock('../../open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer }));

const { useBoardRouteTarget } = await import('../use-board-route-target');
const { resolveBoardForSession: realResolveBoardForSession } = await vi.importActual<
  typeof import('../../board-path-to-user-board')
>('../../board-path-to-user-board');

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

/** A UserBoard on the tuple URL's config unless overridden — angle deliberately not 40. */
function board(overrides: Partial<UserBoard> & { uuid: string }): UserBoard {
  return {
    slug: overrides.uuid,
    boardType: 'kilter',
    layoutId: 1,
    sizeId: 10,
    setIds: '1,20',
    angle: 20,
    ...overrides,
  } as unknown as UserBoard;
}

/** Hand the real resolver back to the hook, for the create / slug branches. */
function useRealResolver() {
  resolveBoardForSession.mockImplementation(realResolveBoardForSession);
}

/** The BOARD_DUPLICATE_CONFIG shape graphql-request throws, as the backend sends it. */
function duplicateBoardRejection(existingBoardUuid: string) {
  return {
    response: {
      errors: [
        { message: 'You already have this board', extensions: { code: 'BOARD_DUPLICATE_CONFIG', existingBoardUuid } },
      ],
    },
  };
}

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
  fetchAllMyBoards.mockResolvedValue([]);
  fetchBoardByUuid.mockResolvedValue(null);
  fetchBoardBySlug.mockResolvedValue(null);
  getStoredActiveBoard.mockResolvedValue(null);
  getOfflineBoards.mockReturnValue([]);
  climbQuery.current = { data: undefined, isError: false, isSuccess: false };
  authState.current = { isAuthenticated: true, isLoading: false };
  connectivity.isOnline = true;
  connectivity.listeners.clear();
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

  // Opening the drawer navigates to `/play`. A deep link has nothing behind it,
  // so it leaves by replacing the current route — do that after the open and the
  // replace lands on `/play` itself, dropping the drawer and leaving the user on
  // a bare climbs tab.
  it('replaces the redirector before opening the drawer on a deep link', async () => {
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };

    render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(openClimbInPlayDrawer).toHaveBeenCalledTimes(1));
    const [replaceOrder] = router.replace.mock.invocationCallOrder;
    const [openOrder] = openClimbInPlayDrawer.mock.invocationCallOrder;
    expect(replaceOrder).toBeLessThan(openOrder);
  });

  // The in-app pop is the mirror image: popping first would take the screen the
  // drawer is supposed to return to with it.
  it('opens the drawer before popping back for an in-app target', async () => {
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };

    render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
        mode: 'in-app',
      }),
    );

    await waitFor(() => expect(openClimbInPlayDrawer).toHaveBeenCalledTimes(1));
    const [openOrder] = openClimbInPlayDrawer.mock.invocationCallOrder;
    const [backOrder] = router.back.mock.invocationCallOrder;
    expect(openOrder).toBeLessThan(backOrder);
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

  // A cold deep-link open lands while the session round-trip is still in flight.
  // Reading that as "signed out" skips the owned-boards wait below and mints a
  // duplicate of a board the user already has.
  it('waits for the session to settle before resolving a tuple URL', async () => {
    authState.current = { isAuthenticated: false, isLoading: true };
    fetchAllMyBoards.mockResolvedValue([RESOLVED_BOARD]);

    const { container, rerender } = render(
      createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }),
    );

    expect(statusOf(container)).toBe('resolving');
    expect(resolveBoardForSession).not.toHaveBeenCalled();

    authState.current = { isAuthenticated: true, isLoading: false };
    rerender(createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }));

    await waitFor(() => expect(resolveBoardForSession).toHaveBeenCalledTimes(1));
    expect(resolveBoardForSession).toHaveBeenCalledWith(
      'kilter/1/10/1,20/40',
      expect.objectContaining({ ownedBoards: [RESOLVED_BOARD] }),
    );
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs'));
  });

  // `/b/{slug}` resolves through the public boardBySlug query and never mints a
  // board, so it must not sit behind the session round-trip.
  it('resolves a slug URL without waiting for the session', async () => {
    authState.current = { isAuthenticated: false, isLoading: true };

    render(createElement(Harness, { target: { kind: 'slug-list', slug: 'the-gym', angle: 40 } as BoardRouteTarget }));

    await waitFor(() => expect(resolveBoardForSession).toHaveBeenCalledTimes(1));
  });

  it('skips the owned-board fetch entirely in in-app mode', async () => {
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };

    render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
        mode: 'in-app',
      }),
    );

    await waitFor(() => expect(openClimbInPlayDrawer).toHaveBeenCalledTimes(1));
    expect(fetchAllMyBoards).not.toHaveBeenCalled();
    expect(getStoredActiveBoard).not.toHaveBeenCalled();
  });

  it('does not mint a duplicate board when the owned-board list could not be loaded', async () => {
    fetchAllMyBoards.mockRejectedValue(new Error('network down'));

    const { container } = render(
      createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('not-found'));
    expect(resolveBoardForSession).not.toHaveBeenCalled();
  });

  // The pagination itself is pinned in `fetch-all-my-boards.test.ts`; what this
  // pins is the hook end: the whole list `fetchAllMyBoards` returns is threaded
  // into the resolver un-sliced, so a match anywhere in it reuses that board
  // instead of minting one, and it lands at the URL's angle.
  it('reuses a matching owned board from anywhere in the list, at the URL angle', async () => {
    useRealResolver();
    const lastBoard = board({ uuid: 'last-in-list' });
    const nonMatching = Array.from({ length: 50 }, (_, index) => board({ uuid: `other-${index}`, sizeId: 99 }));
    fetchAllMyBoards.mockResolvedValue([...nonMatching, lastBoard]);

    render(createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }));

    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledTimes(1));
    // Adopted at the URL's angle, not the board's stored 20.
    expect(setActiveBoard).toHaveBeenCalledWith({ ...lastBoard, angle: 40 });
    expect(createBoardMutateAsync).not.toHaveBeenCalled();
  });

  // The list walk closes the common case but not the race — a board created on
  // another device between the walk and the create still lands as
  // BOARD_DUPLICATE_CONFIG, and the error names the board to use.
  it('adopts the existing board when createBoard rejects as a duplicate', async () => {
    useRealResolver();
    const existingBoard = board({ uuid: 'existing-uuid' });
    createBoardMutateAsync.mockRejectedValue(duplicateBoardRejection('existing-uuid'));
    fetchBoardByUuid.mockResolvedValue(existingBoard);

    const { container } = render(
      createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }),
    );

    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledTimes(1));
    expect(fetchBoardByUuid).toHaveBeenCalledWith('existing-uuid');
    expect(setActiveBoard).toHaveBeenCalledWith({ ...existingBoard, angle: 40 });
    expect(statusOf(container)).toBe('resolving');
  });

  // The headline optimization: the deep link almost always names the wall the
  // user is already on, and matching it skips the owned-list round trip
  // entirely. Asserting the SKIP is the point — resolving correctly via the
  // server list would pass without the shortcut existing at all.
  it('adopts a matching stored active board online without fetching the owned list', async () => {
    const activeBoard = board({ uuid: 'active-uuid' });
    getStoredActiveBoard.mockResolvedValue(activeBoard);

    render(createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }));

    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledWith({ ...activeBoard, angle: 40 }));
    expect(fetchAllMyBoards).not.toHaveBeenCalled();
    expect(resolveBoardForSession).not.toHaveBeenCalled();
  });

  // The stored active board is the board the rest of the app is already pointed
  // at, so a URL that matches it needs no network at all — which is what makes a
  // cold offline open resolve instead of spinning.
  it('adopts the stored active board offline without touching the network', async () => {
    connectivity.isOnline = false;
    const activeBoard = board({ uuid: 'active-uuid' });
    getStoredActiveBoard.mockResolvedValue(activeBoard);

    render(createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }));

    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledWith({ ...activeBoard, angle: 40 }));
    expect(fetchAllMyBoards).not.toHaveBeenCalled();
    expect(resolveBoardForSession).not.toHaveBeenCalled();
  });

  it('falls back to a downloaded board card when offline', async () => {
    connectivity.isOnline = false;
    const downloadedBoard = board({ uuid: 'downloaded-uuid' });
    getOfflineBoards.mockReturnValue([downloadedBoard]);

    render(createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }));

    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledWith({ ...downloadedBoard, angle: 40 }));
    expect(fetchAllMyBoards).not.toHaveBeenCalled();
  });

  // Offline with nothing local can never resolve: the list walk and CREATE_BOARD
  // both need the network. It has to fail rather than await a request React
  // Query pauses, or the route spins forever.
  it('is not found offline when no local board matches', async () => {
    connectivity.isOnline = false;

    const { container } = render(
      createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('not-found'));
    expect(fetchAllMyBoards).not.toHaveBeenCalled();
    expect(resolveBoardForSession).not.toHaveBeenCalled();
  });

  // Online the server list stays authoritative: the local shortcut only applies
  // when the active board actually matches the URL.
  it('falls through to the full owned list when the active board does not match', async () => {
    useRealResolver();
    getStoredActiveBoard.mockResolvedValue(board({ uuid: 'tension-uuid', boardType: 'tension' }));
    const ownedBoard = board({ uuid: 'owned-uuid' });
    fetchAllMyBoards.mockResolvedValue([ownedBoard]);

    render(createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }));

    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledWith({ ...ownedBoard, angle: 40 }));
    expect(fetchAllMyBoards).toHaveBeenCalledTimes(1);
    expect(createBoardMutateAsync).not.toHaveBeenCalled();
  });

  // Online, a stale card (board deleted on another device, not pruned yet) must
  // never be adopted — its uuid is one the backend no longer knows.
  it('ignores downloaded board cards while online', async () => {
    useRealResolver();
    getOfflineBoards.mockReturnValue([board({ uuid: 'stale-card' })]);
    const ownedBoard = board({ uuid: 'owned-uuid' });
    fetchAllMyBoards.mockResolvedValue([ownedBoard]);

    render(createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }));

    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledWith({ ...ownedBoard, angle: 40 }));
  });

  // The named form gets the same local-first treatment, and keeps the named-path
  // angle rule: the URL's angle wins, the board's own is the fallback.
  it('resolves a slug URL from the stored active board while offline', async () => {
    useRealResolver();
    connectivity.isOnline = false;
    const namedBoard = board({ uuid: 'gym-uuid', slug: 'the-gym', angle: 25 });
    getStoredActiveBoard.mockResolvedValue(namedBoard);

    render(createElement(Harness, { target: { kind: 'slug-list', slug: 'the-gym', angle: 40 } as BoardRouteTarget }));

    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledWith({ ...namedBoard, angle: 40 }));
    expect(fetchBoardBySlug).not.toHaveBeenCalled();
  });

  it('keeps the named board angle when a slug URL carries none', async () => {
    useRealResolver();
    connectivity.isOnline = false;
    const namedBoard = board({ uuid: 'gym-uuid', slug: 'the-gym', angle: 25 });
    getStoredActiveBoard.mockResolvedValue(namedBoard);

    render(createElement(Harness, { target: { kind: 'slug-list', slug: 'the-gym', angle: null } as BoardRouteTarget }));

    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledWith(namedBoard));
  });

  // Failing fast offline replaced a paused React Query retryer that used to
  // resume on reconnect. The redirector renders a static not-found with no retry
  // affordance, so without healing here the first tap with no signal would be a
  // permanent dead end.
  it('re-resolves when the network comes back after an offline failure', async () => {
    connectivity.isOnline = false;

    const { container } = render(
      createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('not-found'));
    expect(fetchAllMyBoards).not.toHaveBeenCalled();

    fetchAllMyBoards.mockResolvedValue([RESOLVED_BOARD]);
    act(() => connectivity.goOnline());

    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledWith(RESOLVED_BOARD));
    expect(fetchAllMyBoards).toHaveBeenCalledTimes(1);
    expect(statusOf(container)).toBe('resolving');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs'));
  });

  // A dead slug fails while ONLINE, so no offline→online transition can follow
  // it. Only a device that was genuinely offline gets a retry.
  it('leaves an online not-found alone when the online signal fires again', async () => {
    resolveBoardForSession.mockRejectedValue(new Error('dead slug'));

    const { container } = render(
      createElement(Harness, { target: { kind: 'slug-list', slug: 'gone', angle: null } as BoardRouteTarget }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('not-found'));
    act(() => connectivity.goOnline());

    await waitFor(() => expect(resolveBoardForSession).toHaveBeenCalledTimes(1));
    expect(statusOf(container)).toBe('not-found');
  });

  // `onlineManager` reads online whenever NetInfo says `isConnected` — a captive
  // portal, a dead gym uplink, or a lost cold-start seed race all pass that test
  // while no request can actually reach the server. A walk that provably failed
  // to reach it is better evidence than the flag.
  it('probes downloaded cards when the owned-list walk fails on a lying connection', async () => {
    const downloadedBoard = board({ uuid: 'downloaded-uuid' });
    getOfflineBoards.mockReturnValue([downloadedBoard]);
    fetchAllMyBoards.mockRejectedValue(new TypeError('Network request failed'));

    render(createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }));

    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledWith({ ...downloadedBoard, angle: 40 }));
    expect(resolveBoardForSession).not.toHaveBeenCalled();
  });

  // A rejection carrying a server status is the server's verdict, not a
  // reachability problem — adopting a stale card over it would hand back a board
  // the backend has disowned.
  it('does not adopt a downloaded card when the walk fails with a server status', async () => {
    getOfflineBoards.mockReturnValue([board({ uuid: 'stale-card' })]);
    fetchAllMyBoards.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { response: { status: 403, errors: [{ message: 'Forbidden' }] } }),
    );

    const { container } = render(
      createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('not-found'));
    expect(setActiveBoard).not.toHaveBeenCalled();
    expect(resolveBoardForSession).not.toHaveBeenCalled();
  });

  it('probes downloaded cards when the slug lookup fails on a lying connection', async () => {
    useRealResolver();
    const namedBoard = board({ uuid: 'gym-uuid', slug: 'the-gym', angle: 25 });
    getOfflineBoards.mockReturnValue([namedBoard]);
    fetchBoardBySlug.mockRejectedValue(new TypeError('Network request failed'));

    render(createElement(Harness, { target: { kind: 'slug-list', slug: 'the-gym', angle: 40 } as BoardRouteTarget }));

    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledWith({ ...namedBoard, angle: 40 }));
    expect(fetchBoardBySlug).toHaveBeenCalledWith('the-gym');
  });

  it('does not adopt a downloaded card when the slug lookup fails with a server status', async () => {
    useRealResolver();
    getOfflineBoards.mockReturnValue([board({ uuid: 'gym-uuid', slug: 'the-gym', angle: 25 })]);
    fetchBoardBySlug.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { response: { status: 403, errors: [{ message: 'Forbidden' }] } }),
    );

    const { container } = render(
      createElement(Harness, { target: { kind: 'slug-list', slug: 'the-gym', angle: 40 } as BoardRouteTarget }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('not-found'));
    expect(setActiveBoard).not.toHaveBeenCalled();
  });
});
