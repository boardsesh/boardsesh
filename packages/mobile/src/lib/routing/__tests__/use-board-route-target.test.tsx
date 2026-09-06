// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { createElement, useLayoutEffect, useState } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { buildBoardClimbTarget, type BoardRouteTarget } from '../board-route-target';

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
// Every `useClimb` argument, so a test can assert the query was never armed —
// `null` variables is what keeps it from reaching the server.
const climbQueryVariables = vi.hoisted(() => ({ current: [] as unknown[] }));
// Mirrors AuthProvider: `isLoading` starts true and the session resolves async.
const authState = vi.hoisted(() => ({ current: { isAuthenticated: true, isLoading: false } }));
// `false` is the native fork's value, which is what every pre-existing case in
// this file runs against.
const gateState = vi.hoisted(() => ({ relaxesRoutes: false }));
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
  useClimb: (variables: unknown) => {
    climbQueryVariables.current.push(variables);
    return variables ? climbQuery.current : { data: undefined, isError: false, isSuccess: false };
  },
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
// The platform switch, as a mutable so one suite can exercise both forks. A
// getter (not a captured value) because the hook reads the constant on every
// render and the mock factory runs once.
vi.mock('../anonymous-auth-gate', () => ({
  get RELAXES_ANONYMOUS_ROUTES() {
    return gateState.relaxesRoutes;
  },
  isAnonymousReadOnlyLocation: () => false,
  buildLoginHrefWithReturn: () => '/auth/login',
  readPostLoginReturnHref: () => null,
}));

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

/** A promise the test releases, for holding a resolve open across re-renders. */
function deferredBoard(board: UserBoard) {
  let release = () => {};
  const promise = new Promise<UserBoard>((resolve) => {
    release = () => resolve(board);
  });
  return { promise, release: () => release() };
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

function Harness({
  target,
  mode,
  onHandedOff,
  anonymousClimbEnabled,
}: {
  target: BoardRouteTarget | null;
  mode?: 'deep-link' | 'in-app';
  onHandedOff?: () => void;
  anonymousClimbEnabled?: boolean;
}) {
  const { status, climb, boardConfig, isAngleAdjustable } = useBoardRouteTarget(target, {
    mode,
    onHandedOff,
    anonymousClimbEnabled,
  });
  return createElement('span', {
    'data-status': status,
    'data-climb': climb?.uuid ?? '',
    'data-board-config': boardConfig ? JSON.stringify(boardConfig) : '',
    'data-angle-adjustable': String(isAngleAdjustable),
  });
}

function statusOf(container: HTMLElement): string | null {
  return container.querySelector('span')?.getAttribute('data-status') ?? null;
}

/** The climb the hook hands the route to draw — only ever set anonymously. */
function climbOf(container: HTMLElement): string | null {
  return container.querySelector('span')?.getAttribute('data-climb') ?? null;
}

/** Whether the drawer should offer the angle pill for this board. */
function angleAdjustableOf(container: HTMLElement): string | null {
  return container.querySelector('span')?.getAttribute('data-angle-adjustable') ?? null;
}

/** The board config it draws against, parsed back from the harness. */
function boardConfigOf(container: HTMLElement): unknown {
  const serialised = container.querySelector('span')?.getAttribute('data-board-config');
  return serialised ? JSON.parse(serialised) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` wipes calls, not implementations — and one case below gives
  // `replace` a real one that unmounts the harness.
  router.replace.mockReset();
  router.canGoBack.mockReturnValue(true);
  resolveBoardForSession.mockResolvedValue(RESOLVED_BOARD);
  fetchAllMyBoards.mockResolvedValue([]);
  fetchBoardByUuid.mockResolvedValue(null);
  fetchBoardBySlug.mockResolvedValue(null);
  getStoredActiveBoard.mockResolvedValue(null);
  getOfflineBoards.mockReturnValue([]);
  climbQuery.current = { data: undefined, isError: false, isSuccess: false };
  climbQueryVariables.current = [];
  authState.current = { isAuthenticated: true, isLoading: false };
  gateState.relaxesRoutes = false;
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
    // A recovered duplicate is a successful hand-off, not a dead end.
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs'));
    expect(statusOf(container)).not.toBe('not-found');
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

    // The healed resolve is the longest await chain in this file — a local-board
    // probe, the owned-list walk and the resolver all have to settle before the
    // board is adopted. `waitFor`'s 1s default loses that race on a loaded CI
    // box (observed on PR #4418), so this one gets room. That allowance only
    // means anything because the `it` below raises the per-test budget past it:
    // Vitest's default is also 5s, so a 5s `waitFor` inside a 5s test can never
    // spend its own budget — the test dies first with "Test timed out in
    // 5000ms", which is how this kept flaking after #4418 supposedly fixed it.
    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledWith(RESOLVED_BOARD), { timeout: 5000 });
    expect(fetchAllMyBoards).toHaveBeenCalledTimes(1);
    // The healed resolve hands off; the stale not-found is gone either way.
    expect(statusOf(container)).not.toBe('not-found');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs'));
    // Must exceed the 5s `waitFor` above; see the comment there.
  }, 15000);

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

  // A run cut short leaves the path marked resolved by nothing. Re-running with
  // the SAME path then early-returns on that marker and the redirector sits on
  // its spinner with no way out. StrictMode replays every dev mount, Fast
  // Refresh does the same, and the auth flip below is the production route in.
  it('restarts a resolve that was cancelled before it finished', async () => {
    const held = deferredBoard(RESOLVED_BOARD);
    resolveBoardForSession.mockImplementationOnce(() => held.promise);
    const listTarget = { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget;

    const { container, rerender } = render(createElement(Harness, { target: listTarget }));
    await waitFor(() => expect(resolveBoardForSession).toHaveBeenCalledTimes(1));

    // The session going unsettled blanks boardPath, which cancels the run.
    authState.current = { isAuthenticated: false, isLoading: true };
    rerender(createElement(Harness, { target: listTarget }));
    expect(statusOf(container)).toBe('resolving');

    // ...and the same path comes back.
    authState.current = { isAuthenticated: true, isLoading: false };
    rerender(createElement(Harness, { target: listTarget }));

    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledWith(RESOLVED_BOARD));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs'));
    held.release();
  });

  // The new target is visible a render before the resolve effect can clear the
  // old board, so an untagged board would hand off climb B while board A is
  // still the active board — drawer on B, Climbs tab and BLE on A. Both targets
  // must name DIFFERENT boards for this to bite, which is why the same-board
  // re-target test above can't catch it.
  it('waits for the new board before handing off a second, different-board target', async () => {
    useRealResolver();
    const boardA = board({ uuid: 'gym-a-uuid', slug: 'gym-a', angle: 25 });
    const boardB = board({ uuid: 'gym-b-uuid', slug: 'gym-b', layoutId: 7, angle: 30 });
    fetchBoardBySlug.mockImplementation(async (slug: string) => (slug === 'gym-a' ? boardA : boardB));
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };

    const { rerender } = render(
      createElement(Harness, {
        target: { kind: 'slug-climb', slug: 'gym-a', angle: 40, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );
    await waitFor(() => expect(openClimbInPlayDrawer).toHaveBeenCalledTimes(1));

    // Board B's resolve is held open; its climb is already cached, so nothing but
    // the tagged board state stops the hand-off from firing on board A.
    const heldB = deferredBoard(boardB);
    fetchBoardBySlug.mockImplementation(() => heldB.promise);
    climbQuery.current = { data: { uuid: OTHER_CLIMB_UUID }, isError: false, isSuccess: true };
    rerender(
      createElement(Harness, {
        target: { kind: 'slug-climb', slug: 'gym-b', angle: 40, climbUuid: OTHER_CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    // Re-render again to give a stale board every chance to leak through.
    rerender(
      createElement(Harness, {
        target: { kind: 'slug-climb', slug: 'gym-b', angle: 40, climbUuid: OTHER_CLIMB_UUID } as BoardRouteTarget,
      }),
    );
    expect(openClimbInPlayDrawer).toHaveBeenCalledTimes(1);

    await act(async () => {
      heldB.release();
    });

    await waitFor(() => expect(openClimbInPlayDrawer).toHaveBeenCalledTimes(2));
    expect(setActiveBoard).toHaveBeenNthCalledWith(2, { ...boardB, angle: 40 });
    // The drawer opened on board B's layout, not board A's.
    expect(openClimbInPlayDrawer.mock.calls[1][0]).toMatchObject({
      climb: { uuid: OTHER_CLIMB_UUID },
      boardConfig: { layoutId: 7, angle: 40 },
    });
  });

  // The legacy `climbs/[climbUuid]` redirector is in-app AND cold-openable — the
  // expo-web rollout 307s the whole cohort's numeric climb URLs at it. With
  // nothing behind it, opening first then "leaving" replaces `/play` itself and
  // the drawer never appears. Ordering follows the stack, not the mode.
  it('replaces before opening for an in-app target with nothing to pop back to', async () => {
    router.canGoBack.mockReturnValue(false);
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };

    render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
        mode: 'in-app',
      }),
    );

    await waitFor(() => expect(openClimbInPlayDrawer).toHaveBeenCalledTimes(1));
    const [replaceOrder] = router.replace.mock.invocationCallOrder;
    const [openOrder] = openClimbInPlayDrawer.mock.invocationCallOrder;
    expect(replaceOrder).toBeLessThan(openOrder);
    expect(router.back).not.toHaveBeenCalled();
    // Still in-app: a cold open must not adopt (or mint) the URL's board.
    expect(setActiveBoard).not.toHaveBeenCalled();
  });
});

// Web only: `app.boardsesh.com` serves these routes to a signed-out visitor so
// the climb they arrived for survives the login round trip. Board adoption is
// what forces the short-circuit — the tuple form mints a UserBoard through
// `createBoard`, which is `requireAuthenticated`.
describe('useBoardRouteTarget signed-out on web', () => {
  it('short-circuits a deep link to auth-required without resolving anything', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };

    const { container } = render(
      createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('auth-required'));
    // The assertion that matters: nothing was asked of the server, and no board
    // was adopted or minted, on behalf of someone with no account.
    expect(resolveBoardForSession).not.toHaveBeenCalled();
    expect(fetchAllMyBoards).not.toHaveBeenCalled();
    expect(createBoardMutateAsync).not.toHaveBeenCalled();
    expect(setActiveBoard).not.toHaveBeenCalled();
    expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  // A shared gym-board link is the same kind of arrival as a search result. It
  // carries no config, so unlike the tuple form it does resolve — but by the
  // public `boardBySlug` read, with nothing minted and nothing stored.
  it('renders a slug climb URL anonymously off one public board read', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };
    fetchBoardBySlug.mockResolvedValue(board({ uuid: 'gym-board', slug: 'the-gym', angle: 25 }));

    const { container } = render(
      createElement(Harness, {
        target: { kind: 'slug-climb', slug: 'the-gym', angle: 40, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('anonymous-climb'));
    expect(fetchBoardBySlug).toHaveBeenCalledWith('the-gym');
    // The URL's angle wins over the board's stored 25°.
    expect(boardConfigOf(container)).toEqual({ ...KILTER_BOARD, angle: 40 });
    expect(createBoardMutateAsync).not.toHaveBeenCalled();
    expect(setActiveBoard).not.toHaveBeenCalled();
    expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  // The board's own stored angle when the URL carries none.
  it('falls back to the board’s stored angle on a bare /b/{slug} climb URL', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };
    fetchBoardBySlug.mockResolvedValue(board({ uuid: 'gym-board', slug: 'the-gym', angle: 25 }));

    const { container } = render(
      createElement(Harness, {
        target: { kind: 'slug-climb', slug: 'the-gym', angle: null, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('anonymous-climb'));
    expect(boardConfigOf(container)).toEqual({ ...KILTER_BOARD, angle: 25 });
  });

  // A PRIVATE board must not turn into a dead link. `boardBySlug` masks "you may
  // not see this board" and "there is no such board" to the same null, so
  // not-found here would tell a gym member their own board does not exist — on a
  // URL that, before this branch existed, simply asked them to sign in and then
  // showed them the climb. Sign-in is the only answer that is right either way,
  // and the only one that resolves the ambiguity: signed in, the same URL either
  // renders or reaches the route's own not-found.
  it('asks a signed-out reader to sign in when the slug resolves to nothing', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };
    fetchBoardBySlug.mockResolvedValue(null);

    const { container } = render(
      createElement(Harness, {
        target: { kind: 'slug-climb', slug: 'private-gym', angle: 40, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('auth-required'));
    expect(climbOf(container)).toBe('');
  });

  // The device's stored board belongs to whoever last signed in on this browser.
  // Matching a slug against it would show an anonymous reader someone else's
  // board, so the anonymous read is server-only.
  it('never resolves an anonymous slug against the device’s stored boards', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };
    getStoredActiveBoard.mockResolvedValue(board({ uuid: 'someone-elses', slug: 'the-gym' }));
    fetchBoardBySlug.mockResolvedValue(null);

    const { container } = render(
      createElement(Harness, {
        target: { kind: 'slug-climb', slug: 'the-gym', angle: 40, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    // The login wall, not the stranger's board: the stored one is never read on
    // this path, so the server's null is the whole answer.
    await waitFor(() => expect(statusOf(container)).toBe('auth-required'));
    expect(boardConfigOf(container)).toBeNull();
  });

  // A transport failure lands in the same place as a masked board, on purpose:
  // there is no offline healing on this path (it only exists on the web export,
  // where a reload is the retry), and a failed read says nothing about whether
  // the climb is there. What it must never be is a permanent spinner. Pinned
  // because it is a deliberate choice — anyone adding a retry here should have to
  // change a test that says so.
  it('sends a failed slug lookup to the login wall rather than spinning', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };
    fetchBoardBySlug.mockRejectedValue(new Error('network down'));

    const { container } = render(
      createElement(Harness, {
        target: { kind: 'slug-climb', slug: 'the-gym', angle: 40, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('auth-required'));
    expect(climbOf(container)).toBe('');
  });

  // A slug LIST URL still needs a board it can adopt, so it keeps the login wall.
  it('still hands a slug list URL to login', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };

    const { container } = render(
      createElement(Harness, {
        target: { kind: 'slug-list', slug: 'the-gym', angle: 40 } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('auth-required'));
    expect(fetchBoardBySlug).not.toHaveBeenCalled();
  });

  // A tuple climb URL is the one shape that renders with no account: it carries
  // the whole board config, so the climb query can arm without resolving
  // anything, and the board it would have adopted is not a render input.
  //
  // The positive assertions are the point. `status !== 'auth-required'` would
  // stay green for a silently blank render, which is the failure this branch is
  // most likely to produce.
  it('renders a tuple climb URL in place for a signed-out reader, adopting nothing', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };

    const { container } = render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('anonymous-climb'));
    // The climb the route hands the drawer, and the config it draws it against —
    // both straight off the URL.
    expect(climbOf(container)).toBe(CLIMB_UUID);
    expect(boardConfigOf(container)).toEqual(KILTER_BOARD);
    expect(climbQueryVariables.current).toContainEqual({ ...KILTER_BOARD, climbUuid: CLIMB_UUID });
    // Nothing was minted, walked, stored or navigated on their behalf.
    expect(resolveBoardForSession).not.toHaveBeenCalled();
    expect(fetchAllMyBoards).not.toHaveBeenCalled();
    expect(createBoardMutateAsync).not.toHaveBeenCalled();
    expect(setActiveBoard).not.toHaveBeenCalled();
    // `/climbs` and `/play` are both behind the login gate, and AuthProvider
    // re-reads the location on every navigation — so a hand-off here IS the
    // bounce back to login.
    expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  // A gym board bolted at a fixed angle resolves with `isAngleAdjustable: false`.
  // The flag only exists on a board record, so the slug branch is the only place
  // the anonymous view can learn it — dropping it at this boundary is invisible
  // downstream, because the drawer's own default is an angle pill.
  it('carries a fixed-angle gym board’s no-tilt setting through to the view', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };
    fetchBoardBySlug.mockResolvedValue(board({ uuid: 'gym-board', slug: 'the-gym', isAngleAdjustable: false }));

    const { container } = render(
      createElement(Harness, {
        target: { kind: 'slug-climb', slug: 'the-gym', angle: 40, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('anonymous-climb'));
    expect(angleAdjustableOf(container)).toBe('false');
  });

  it('keeps the angle pill for a gym board that does tilt', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };
    fetchBoardBySlug.mockResolvedValue(board({ uuid: 'gym-board', slug: 'the-gym', isAngleAdjustable: true }));

    const { container } = render(
      createElement(Harness, {
        target: { kind: 'slug-climb', slug: 'the-gym', angle: 40, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('anonymous-climb'));
    expect(angleAdjustableOf(container)).toBe('true');
  });

  // A tuple URL carries no board record, so there is nothing to read the flag
  // off — it keeps the same default `createBoard` would have stored.
  it('leaves a config-tuple URL adjustable', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };

    const { container } = render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('anonymous-climb'));
    expect(angleAdjustableOf(container)).toBe('true');
  });

  // The anonymous branch has nothing to draw until the climb lands. Loosening
  // this to the branch alone is not benign: `BoardRouteHandoff` only renders the
  // view when it holds BOTH a climb and a config, so a still-loading anonymous
  // climb would fall through to the redirector — and the existing
  // "reports a missing climb as not-found" case stays green either way, because
  // `climbIsGone` runs first and masks it.
  it('sits on the spinner while an anonymous climb is still loading', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };
    climbQuery.current = { data: undefined, isError: false, isSuccess: false };

    const { container } = render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(climbQueryVariables.current.length).toBeGreaterThan(0));
    expect(statusOf(container)).toBe('resolving');
    expect(climbOf(container)).toBe('');
  });

  // `/…/{angle}/play/{segment}` opens anonymously too, and that is a decision
  // rather than an accident. The two route files differ only in the surface they
  // pass to `buildBoardClimbTarget`, which drops it — so both produce the same
  // `kind: 'climb'` target and the predicate here cannot tell them apart. Left
  // that way on purpose: `/play/…` is in the read-only allow-set, older shares
  // and the web app's play view still emit it, and a reader who followed one
  // would otherwise be the only arrival still meeting the login form.
  //
  // Built through the real builder rather than a literal, because the claim is
  // about the ROUTE, not about a target shape a test made up. What stays gated is
  // the app's own `/play` MODAL route — `read-only-routes.test.ts` pins that.
  it('renders a /play climb URL anonymously as well, by the same target', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };

    const playTarget = buildBoardClimbTarget(
      { boardName: 'kilter', layoutId: 'original', sizeId: '12x12-square', setIds: 'screw_bolt', angle: '40' },
      'play',
      CLIMB_UUID,
    );

    const { container } = render(createElement(Harness, { target: playTarget }));

    await waitFor(() => expect(statusOf(container)).toBe('anonymous-climb'));
    expect(climbOf(container)).toBe(CLIMB_UUID);
    expect(boardConfigOf(container)).toEqual(KILTER_BOARD);
    expect(router.replace).not.toHaveBeenCalled();
  });

  // THE FLEET-SAFETY ORACLE. Every merge to main touching packages/mobile
  // auto-publishes a production OTA, and a JS-only diff keeps the fingerprint,
  // so this lands on every installed binary within hours. One constant stands
  // between the store fleet and an anonymous route tree.
  //
  // Phrased positively on purpose: the pre-existing `not.toBe('auth-required')`
  // assertion stays GREEN under exactly the mutation it looks like it catches,
  // because the anonymous branch is not 'auth-required' either.
  it('still adopts and hands off on the native fork, byte for byte', async () => {
    gateState.relaxesRoutes = false;
    authState.current = { isAuthenticated: false, isLoading: false };
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };

    const { container } = render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledWith(RESOLVED_BOARD));
    await waitFor(() => expect(openClimbInPlayDrawer).toHaveBeenCalledTimes(1));
    expect(statusOf(container)).not.toBe('anonymous-climb');
  });

  // The kill switch. Flipping it in PostHog restores the login wall without a
  // new binary or a new OTA.
  it('falls back to the login wall when the anonymous view is killed', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };

    const { container } = render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
        anonymousClimbEnabled: false,
      }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('auth-required'));
    expect(climbQueryVariables.current.every((variables) => variables === null)).toBe(true);
    expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
  });

  // The switch is for an emergency, so it has to work on a session already in
  // flight — not only on one that starts killed. Flipping it mid-render must
  // hand the reader back to the login wall.
  it('hands the reader to login when the kill switch flips mid-session', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };
    const target = { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget;

    const { container, rerender } = render(createElement(Harness, { target, anonymousClimbEnabled: true }));
    await waitFor(() => expect(statusOf(container)).toBe('anonymous-climb'));

    rerender(createElement(Harness, { target, anonymousClimbEnabled: false }));

    await waitFor(() => expect(statusOf(container)).toBe('auth-required'));
    // And it must not have handed off on the way out — `/play` is still gated.
    expect(openClimbInPlayDrawer).not.toHaveBeenCalled();
    expect(setActiveBoard).not.toHaveBeenCalled();
  });

  // A climb URL relaxes; a list URL does not. The list surface needs a board,
  // and minting one is `requireAuthenticated`.
  it('still hands a list URL to login', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };

    const { container } = render(
      createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('auth-required'));
    expect(resolveBoardForSession).not.toHaveBeenCalled();
  });

  // A dead climb uuid is a dead link for a signed-out reader too — the anonymous
  // branch must not paper over it with a permanent spinner.
  it('reports a missing climb as not-found rather than spinning anonymously', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };
    climbQuery.current = { data: undefined, isError: false, isSuccess: true };

    const { container } = render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(statusOf(container)).toBe('not-found'));
  });

  // The same URL signed IN still loads its climb — the gate above must not be a
  // permanent muzzle on the query.
  it('arms the climb query as soon as the visitor has an account', async () => {
    gateState.relaxesRoutes = true;
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };

    render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
      }),
    );

    await waitFor(() => expect(openClimbInPlayDrawer).toHaveBeenCalledTimes(1));
    expect(climbQueryVariables.current).toContainEqual({ ...KILTER_BOARD, climbUuid: CLIMB_UUID });
  });

  // An unsettled session reads as signed-out for a beat on every cold open.
  // Bouncing on it would send signed-in visitors to login too.
  it('waits for the session to settle before deciding auth is required', () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: true };

    const { container } = render(
      createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }),
    );

    expect(statusOf(container)).toBe('resolving');
  });

  // The native fork's constant `false` is what makes this whole branch
  // unreachable on the store fleet — the same signed-out state resolves as it
  // always has.
  it('never reports auth-required when the platform does not relax routes', async () => {
    gateState.relaxesRoutes = false;
    authState.current = { isAuthenticated: false, isLoading: false };

    const { container } = render(
      createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget }),
    );

    await waitFor(() => expect(setActiveBoard).toHaveBeenCalledWith(RESOLVED_BOARD));
    expect(statusOf(container)).not.toBe('auth-required');
  });

  // `in-app` adopts nothing, so there is nothing to need an account for.
  it('does not short-circuit an in-app target', async () => {
    gateState.relaxesRoutes = true;
    authState.current = { isAuthenticated: false, isLoading: false };
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };

    const { container } = render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
        mode: 'in-app',
      }),
    );

    await waitFor(() => expect(openClimbInPlayDrawer).toHaveBeenCalledTimes(1));
    expect(statusOf(container)).not.toBe('auth-required');
  });
});

// The hand-off is reported through a callback rather than a status because the
// screen is gone by the time a status could be read: `leave()` removes it from
// the navigator in the same React batch any state update would land in, so the
// render carrying it is discarded with the fiber. The last case here is the one
// that actually proves it — a router that really unmounts.
describe('useBoardRouteTarget hand-off callback', () => {
  it('reports once a list URL has handed off', async () => {
    const onHandedOff = vi.fn();

    render(createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget, onHandedOff }));

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/(tabs)/climbs'));
    expect(onHandedOff).toHaveBeenCalledTimes(1);
  });

  it('reports once a climb URL has opened the drawer', async () => {
    climbQuery.current = { data: { uuid: CLIMB_UUID }, isError: false, isSuccess: true };
    const onHandedOff = vi.fn();

    render(
      createElement(Harness, {
        target: { kind: 'climb', board: KILTER_BOARD, climbUuid: CLIMB_UUID } as BoardRouteTarget,
        onHandedOff,
      }),
    );

    await waitFor(() => expect(openClimbInPlayDrawer).toHaveBeenCalledTimes(1));
    expect(onHandedOff).toHaveBeenCalledTimes(1);
  });

  it('stays quiet while the board is still resolving', async () => {
    const deferred = deferredBoard(RESOLVED_BOARD);
    resolveBoardForSession.mockReturnValue(deferred.promise);
    const onHandedOff = vi.fn();

    render(createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget, onHandedOff }));

    await waitFor(() => expect(resolveBoardForSession).toHaveBeenCalled());
    expect(onHandedOff).not.toHaveBeenCalled();

    await act(async () => {
      deferred.release();
    });
    await waitFor(() => expect(onHandedOff).toHaveBeenCalledTimes(1));
  });

  // The regression the callback exists for. Every other case in this file runs
  // against `replace: vi.fn()`, which leaves the redirector mounted — production
  // does not. Here the replace really removes the screen, in the same batch the
  // hand-off runs in, and the report still has to come out.
  it('reports even when the replace unmounts the screen in the same batch', async () => {
    const onHandedOff = vi.fn();
    const navigator = { leave: () => {} };
    router.replace.mockImplementation(() => navigator.leave());

    function Navigator() {
      const [mounted, setMounted] = useState(true);
      // Layout effect, so `leave` is wired before the hook's passive hand-off
      // effect runs in the same commit.
      useLayoutEffect(() => {
        navigator.leave = () => setMounted(false);
      }, []);
      return mounted
        ? createElement(Harness, { target: { kind: 'list', board: KILTER_BOARD } as BoardRouteTarget, onHandedOff })
        : createElement('span', { 'data-status': 'unmounted' });
    }

    const { container } = render(createElement(Navigator));

    await waitFor(() => expect(statusOf(container)).toBe('unmounted'));
    expect(onHandedOff).toHaveBeenCalledTimes(1);
  });
});
