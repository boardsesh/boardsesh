// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { BoardCandidate, ClimbQueueItemInput, ResolvedBoard } from '@boardsesh/shared-schema';

const transport = vi.hoisted(() => ({
  resolveBoardForSerial: vi.fn(
    async (_args: unknown) => ({ boardId: 42, boardName: 'Garage Wall' }) as unknown as ResolvedBoard,
  ),
  // No base implementation: the resolved value is set in `beforeEach`, so a
  // per-test `mockResolvedValue` actually overrides it (a base impl would win).
  resolveBoardCandidatesForSerial: vi.fn(),
  chooseBoardForSerial: vi.fn(),
  resolveBoardForUuid: vi.fn(
    async (_args: unknown) => ({ boardId: 44, boardName: 'Named Board' }) as unknown as ResolvedBoard,
  ),
  resolveBoardForConfig: vi.fn(
    async (_args: unknown) => ({ boardId: 43, boardName: 'MoonBoard 40' }) as unknown as ResolvedBoard,
  ),
  reportClimb: vi.fn(async () => true),
}));
const sharedProvider = vi.hoisted(() => ({
  lastBoardId: undefined as number | null | undefined,
  lastClient: undefined as unknown,
  lastOnCatchUp: undefined as ((info: { reason: string; recoveredThroughSeqDelta: number }) => void) | undefined,
}));
// The offline-mode switch, read through the same narrowed selector the provider
// uses. Presence is the one realtime consumer whose transport opens a socket on
// demand, so this is what stops it re-dialling (issue #4862).
const connectivity = vi.hoisted(() => ({ offlineMode: false }));
// The refresh action exposed by the (mocked) shared actions context, and a track
// spy — so we can assert the foreground sync and catch-up telemetry wiring.
const refreshMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const disambiguationSheet = vi.hoisted(() => ({
  props: null as {
    visible: boolean;
    candidates: BoardCandidate[];
    onPick: (boardId: number) => void;
    onCancel: () => void;
  } | null,
}));
// Capture the AppState 'change' handler so a test can fire 'active'/'background'.
const appState = vi.hoisted(() => {
  const ref: { handler: ((state: string) => void) | null } = { handler: null };
  return {
    addEventListener: vi.fn((_event: string, cb: (state: string) => void) => {
      ref.handler = cb;
      return { remove: vi.fn() };
    }),
    fire: (state: string) => ref.handler?.(state),
  };
});

vi.mock('react-native', () => ({
  AppState: { addEventListener: appState.addEventListener },
}));

vi.mock('../../lib/analytics', () => ({ track: trackMock }));

// Board presence is always-on (the flag was removed); the provider no longer
// reads useFeatureFlag, but stub the module so nothing transitively loads the
// real PostHog-backed provider in jsdom.
vi.mock('../feature-flags-provider', () => ({
  useFeatureFlag: () => undefined,
}));

vi.mock('../../lib/board-presence/board-presence-client', () => ({
  createMobileBoardPresenceClient: () => ({
    resolveBoardForSerial: transport.resolveBoardForSerial,
    resolveBoardCandidatesForSerial: transport.resolveBoardCandidatesForSerial,
    chooseBoardForSerial: transport.chooseBoardForSerial,
    resolveBoardForUuid: transport.resolveBoardForUuid,
    resolveBoardForConfig: transport.resolveBoardForConfig,
    subscribeNowPlaying: () => () => {},
    fetchRecentClimbs: async () => [],
    fetchStats: async () => null,
    reportClimb: transport.reportClimb,
  }),
}));

vi.mock('../../lib/graphql/ws-client', () => ({ getWsClient: () => ({}) }));

vi.mock('../../lib/connectivity/use-connectivity', () => ({
  selectOfflineMode: (snapshot: { offlineMode: boolean }) => snapshot.offlineMode,
  useConnectivityField: (select: (snapshot: { offlineMode: boolean }) => boolean) =>
    select({ offlineMode: connectivity.offlineMode }),
}));

// Keep react-native host components (the disambiguation Modal) out of this
// jsdom suite — it asserts provider logic, not the picker UI.
vi.mock('../../components/board-discovery/BoardDisambiguationSheet', () => ({
  BoardDisambiguationSheet: (props: NonNullable<typeof disambiguationSheet.props>) => {
    disambiguationSheet.props = props;
    return null;
  },
}));

// Capture the boardId handed to the shared provider so we can assert it updates
// after resolve.
vi.mock('@boardsesh/board-presence-react', () => ({
  BoardPresenceProvider: ({
    boardId,
    client,
    onCatchUp,
    children,
  }: {
    boardId: number | null;
    client: unknown;
    onCatchUp?: (info: { reason: string; recoveredThroughSeqDelta: number }) => void;
    children: ReactNode;
  }) => {
    sharedProvider.lastBoardId = boardId;
    sharedProvider.lastClient = client;
    sharedProvider.lastOnCatchUp = onCatchUp;
    return createElement('div', { 'data-board-id': String(boardId) }, children);
  },
  // BoardPresenceForegroundSync (rendered inside the provider) reads this.
  useBoardPresenceActions: () => ({ refresh: refreshMock }),
}));

import {
  MobileBoardPresenceProvider,
  useBoardPresenceControls,
  type BoardBindingIdentity,
} from '../board-presence-provider';

let capturedControls: ReturnType<typeof useBoardPresenceControls> | null = null;
function Probe() {
  const controls = useBoardPresenceControls();
  useEffect(() => {
    capturedControls = controls;
  }, [controls]);
  return null;
}

function renderProvider() {
  return render(createElement(MobileBoardPresenceProvider, null, createElement(Probe)));
}

describe('MobileBoardPresenceProvider', () => {
  beforeEach(() => {
    transport.resolveBoardForSerial.mockClear();
    transport.resolveBoardForSerial.mockResolvedValue({
      boardId: 42,
      boardName: 'Garage Wall',
    } as unknown as ResolvedBoard);
    transport.resolveBoardCandidatesForSerial.mockClear();
    transport.resolveBoardCandidatesForSerial.mockResolvedValue({
      board: { boardId: 42, boardName: 'Garage Wall' },
      candidates: null,
    } as unknown as { board: ResolvedBoard | null; candidates: unknown[] | null });
    transport.chooseBoardForSerial.mockClear();
    transport.chooseBoardForSerial.mockResolvedValue({
      boardId: 77,
      boardName: 'Picked Wall',
    } as unknown as ResolvedBoard);
    transport.resolveBoardForConfig.mockClear();
    transport.resolveBoardForConfig.mockResolvedValue({
      boardId: 43,
      boardName: 'MoonBoard 40',
    } as unknown as ResolvedBoard);
    transport.resolveBoardForUuid.mockClear();
    transport.resolveBoardForUuid.mockResolvedValue({
      boardId: 44,
      boardName: 'Named Board',
    } as unknown as ResolvedBoard);
    transport.reportClimb.mockClear();
    transport.reportClimb.mockResolvedValue(true);
    sharedProvider.lastBoardId = undefined;
    sharedProvider.lastClient = undefined;
    sharedProvider.lastOnCatchUp = undefined;
    connectivity.offlineMode = false;
    refreshMock.mockClear();
    trackMock.mockClear();
    appState.addEventListener.mockClear();
    disambiguationSheet.props = null;
    capturedControls = null;
  });

  it('falls back to inert disabled controls when used outside the provider', () => {
    // No MobileBoardPresenceProvider in the tree → DISABLED_CONTROLS.
    render(createElement(Probe));
    expect(capturedControls?.enabled).toBe(false);
  });

  it('starts with a null boardId and enabled controls until a board is bound', () => {
    renderProvider();
    expect(sharedProvider.lastBoardId).toBeNull();
    expect(capturedControls?.enabled).toBe(true);
  });

  it('resolves+binds the board and feeds its id to the shared provider', async () => {
    renderProvider();
    expect(capturedControls?.enabled).toBe(true);

    await act(async () => {
      const resolved = await capturedControls?.resolveAndBindBoard({
        serial: 'SERIAL-1',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
      });
      expect(resolved?.boardId).toBe(42);
    });

    expect(transport.resolveBoardCandidatesForSerial).toHaveBeenCalledWith({
      serial: 'SERIAL-1',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
    });
    await waitFor(() => {
      expect(sharedProvider.lastBoardId).toBe(42);
    });
  });

  it('does not re-resolve an unchanged serial once bound', async () => {
    renderProvider();

    const args = { serial: 'SERIAL-1', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' };
    await act(async () => {
      await capturedControls?.resolveAndBindBoard(args);
    });
    let cachedBinding: BoardBindingIdentity | null | undefined;
    await act(async () => {
      cachedBinding = await capturedControls?.resolveAndBindBoard(args);
    });
    expect(cachedBinding).toEqual({ boardId: 42 });
    expect(transport.resolveBoardCandidatesForSerial).toHaveBeenCalledTimes(1);
  });

  it('re-resolves the same serial when its board config changes', async () => {
    renderProvider();
    const originalArgs = { serial: 'SERIAL-1', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' };

    await act(async () => {
      await capturedControls?.resolveAndBindBoard(originalArgs);
    });
    await waitFor(() => {
      expect(sharedProvider.lastBoardId).toBe(42);
    });

    transport.resolveBoardCandidatesForSerial.mockResolvedValueOnce({
      board: { boardId: 45, boardName: 'Reset Wall' },
      candidates: null,
    } as unknown as { board: ResolvedBoard | null; candidates: unknown[] | null });
    let rebound: BoardBindingIdentity | null | undefined;
    await act(async () => {
      rebound = await capturedControls?.resolveAndBindBoard({ ...originalArgs, setIds: '3,4' });
    });

    expect(rebound).toEqual(expect.objectContaining({ boardId: 45 }));
    expect(transport.resolveBoardCandidatesForSerial).toHaveBeenCalledTimes(2);
    expect(sharedProvider.lastBoardId).toBe(45);
  });

  it('shares an in-flight serial+config result with a same-wall reconnect', async () => {
    let resolveBoard: ((value: { board: ResolvedBoard; candidates: null }) => void) | null = null;
    transport.resolveBoardCandidatesForSerial.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBoard = resolve;
        }),
    );
    renderProvider();
    const args = { serial: 'SERIAL-1', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' };

    let firstPromise: Promise<BoardBindingIdentity | null> | undefined;
    let reconnectPromise: Promise<BoardBindingIdentity | null> | undefined;
    act(() => {
      firstPromise = capturedControls?.resolveAndBindBoard(args);
      reconnectPromise = capturedControls?.resolveAndBindBoard(args);
    });
    expect(transport.resolveBoardCandidatesForSerial).toHaveBeenCalledTimes(1);

    let firstBinding: BoardBindingIdentity | null | undefined;
    let reconnectBinding: BoardBindingIdentity | null | undefined;
    await act(async () => {
      resolveBoard?.({
        board: { boardId: 42, boardName: 'Garage Wall' } as unknown as ResolvedBoard,
        candidates: null,
      });
      [firstBinding, reconnectBinding] = await Promise.all([firstPromise, reconnectPromise]);
    });

    expect(firstBinding).toEqual({ boardId: 42 });
    expect(reconnectBinding).toEqual({ boardId: 42 });
  });

  it('shares an ambiguous serial resolution until the picker binds a board', async () => {
    transport.resolveBoardCandidatesForSerial.mockResolvedValue({
      board: null,
      candidates: [
        { boardId: 1, boardUuid: 'a', boardName: 'Home', boardType: 'kilter', isOwnedByMe: true, isPublic: false },
        { boardId: 2, boardUuid: 'b', boardName: 'Gym', boardType: 'kilter', isOwnedByMe: false, isPublic: true },
      ],
    } as unknown as { board: ResolvedBoard | null; candidates: unknown[] | null });
    renderProvider();

    const args = {
      serial: 'SHARED-SERIAL',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
    };
    let firstPromise: Promise<BoardBindingIdentity | null> | undefined;
    let reconnectPromise: Promise<BoardBindingIdentity | null> | undefined;
    act(() => {
      firstPromise = capturedControls?.resolveAndBindBoard(args);
    });
    await waitFor(() => {
      expect(disambiguationSheet.props?.visible).toBe(true);
    });
    act(() => {
      reconnectPromise = capturedControls?.resolveAndBindBoard(args);
    });
    expect(transport.resolveBoardCandidatesForSerial).toHaveBeenCalledTimes(1);

    let firstBinding: BoardBindingIdentity | null | undefined;
    let reconnectBinding: BoardBindingIdentity | null | undefined;
    await act(async () => {
      disambiguationSheet.props?.onPick(2);
      [firstBinding, reconnectBinding] = await Promise.all([firstPromise, reconnectPromise]);
    });

    expect(transport.chooseBoardForSerial).toHaveBeenCalledWith({ boardId: 2, serial: 'SHARED-SERIAL' });
    expect(firstBinding).toEqual({ boardId: 77 });
    expect(reconnectBinding).toEqual({ boardId: 77 });
    expect(sharedProvider.lastBoardId).toBe(77);
  });

  it('settles an ambiguous serial resolution with null when the picker is cancelled', async () => {
    transport.resolveBoardCandidatesForSerial.mockResolvedValue({
      board: null,
      candidates: [
        { boardId: 1, boardUuid: 'a', boardName: 'Home', boardType: 'kilter', isOwnedByMe: true, isPublic: false },
      ],
    } as unknown as { board: ResolvedBoard | null; candidates: unknown[] | null });
    renderProvider();

    let bindingPromise: Promise<BoardBindingIdentity | null> | undefined;
    act(() => {
      bindingPromise = capturedControls?.resolveAndBindBoard({
        serial: 'SHARED-SERIAL',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
      });
    });
    await waitFor(() => {
      expect(disambiguationSheet.props?.visible).toBe(true);
    });

    let binding: BoardBindingIdentity | null | undefined;
    await act(async () => {
      disambiguationSheet.props?.onCancel();
      binding = await bindingPromise;
    });

    expect(binding).toBeNull();
    expect(sharedProvider.lastBoardId).toBeNull();
    expect(disambiguationSheet.props?.visible).toBe(false);
  });

  it('invalidates an ambiguous serial deferred when a different binding key starts', async () => {
    transport.resolveBoardCandidatesForSerial.mockResolvedValue({
      board: null,
      candidates: [
        { boardId: 1, boardUuid: 'a', boardName: 'Home', boardType: 'kilter', isOwnedByMe: true, isPublic: false },
      ],
    } as unknown as { board: ResolvedBoard | null; candidates: unknown[] | null });
    renderProvider();

    let serialPromise: Promise<BoardBindingIdentity | null> | undefined;
    act(() => {
      serialPromise = capturedControls?.resolveAndBindBoard({
        serial: 'SHARED-SERIAL',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
      });
    });
    await waitFor(() => {
      expect(disambiguationSheet.props?.visible).toBe(true);
    });

    let uuidBinding: BoardBindingIdentity | null | undefined;
    let serialBinding: BoardBindingIdentity | null | undefined;
    await act(async () => {
      const uuidPromise = capturedControls?.resolveAndBindBoardByUuid({
        boardUuid: '11111111-1111-4111-8111-111111111111',
      });
      [serialBinding, uuidBinding] = await Promise.all([serialPromise, uuidPromise]);
    });

    expect(serialBinding).toBeNull();
    expect(uuidBinding).toEqual({ boardId: 44 });
    expect(disambiguationSheet.props?.visible).toBe(false);
    expect(sharedProvider.lastBoardId).toBe(44);
  });

  it('resolves+binds by config when no serial is available', async () => {
    renderProvider();

    await act(async () => {
      const resolved = await capturedControls?.resolveAndBindBoardByConfig({
        boardType: 'moonboard',
        layoutId: 1,
        sizeId: 1,
        setIds: '2019',
      });
      expect(resolved?.boardId).toBe(43);
    });

    expect(transport.resolveBoardForConfig).toHaveBeenCalledWith({
      boardType: 'moonboard',
      layoutId: 1,
      sizeId: 1,
      setIds: '2019',
    });
    await waitFor(() => {
      expect(sharedProvider.lastBoardId).toBe(43);
    });
  });

  it('resolves+binds by board uuid for selected named boards', async () => {
    renderProvider();

    await act(async () => {
      const resolved = await capturedControls?.resolveAndBindBoardByUuid({
        boardUuid: '11111111-1111-4111-8111-111111111111',
      });
      expect(resolved?.boardId).toBe(44);
    });

    expect(transport.resolveBoardForUuid).toHaveBeenCalledWith({
      boardUuid: '11111111-1111-4111-8111-111111111111',
    });
    await waitFor(() => {
      expect(sharedProvider.lastBoardId).toBe(44);
    });
  });

  it('returns the cached board identity without re-resolving an unchanged uuid', async () => {
    renderProvider();
    const args = { boardUuid: '11111111-1111-4111-8111-111111111111' };

    await act(async () => {
      await capturedControls?.resolveAndBindBoardByUuid(args);
    });
    await waitFor(() => {
      expect(sharedProvider.lastBoardId).toBe(44);
    });

    let cachedBinding: BoardBindingIdentity | null | undefined;
    await act(async () => {
      cachedBinding = await capturedControls?.resolveAndBindBoardByUuid(args);
    });

    expect(cachedBinding).toEqual({ boardId: 44 });
    expect(transport.resolveBoardForUuid).toHaveBeenCalledTimes(1);
  });

  it('shares the in-flight result without starting a second uuid resolve', async () => {
    let resolveBoard: ((value: ResolvedBoard) => void) | null = null;
    transport.resolveBoardForUuid.mockImplementationOnce(
      () =>
        new Promise<ResolvedBoard>((resolve) => {
          resolveBoard = resolve;
        }),
    );
    renderProvider();

    let firstPromise: Promise<BoardBindingIdentity | null> | undefined;
    act(() => {
      firstPromise = capturedControls?.resolveAndBindBoardByUuid({
        boardUuid: '11111111-1111-4111-8111-111111111111',
      });
    });

    let secondPromise: Promise<BoardBindingIdentity | null> | undefined;
    act(() => {
      secondPromise = capturedControls?.resolveAndBindBoardByUuid({
        boardUuid: '11111111-1111-4111-8111-111111111111',
      });
    });

    expect(transport.resolveBoardForUuid).toHaveBeenCalledTimes(1);

    let firstResult: BoardBindingIdentity | null | undefined;
    let secondResult: BoardBindingIdentity | null | undefined;
    await act(async () => {
      resolveBoard?.({ boardId: 44, boardName: 'Named Board' } as unknown as ResolvedBoard);
      [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    });
    expect(firstResult).toEqual({ boardId: 44 });
    expect(secondResult).toEqual({ boardId: 44 });
    await waitFor(() => {
      expect(sharedProvider.lastBoardId).toBe(44);
    });
  });

  it('does not re-resolve an unchanged config once bound', async () => {
    renderProvider();

    const args = {
      boardType: 'moonboard',
      layoutId: 1,
      sizeId: 1,
      setIds: '2019',
    };
    await act(async () => {
      await capturedControls?.resolveAndBindBoardByConfig(args);
    });
    await waitFor(() => {
      expect(sharedProvider.lastBoardId).toBe(43);
    });

    await act(async () => {
      const resolved = await capturedControls?.resolveAndBindBoardByConfig(args);
      expect(resolved).toEqual({ boardId: 43 });
    });
    expect(transport.resolveBoardForConfig).toHaveBeenCalledTimes(1);
  });

  it('shares an in-flight config result with a same-wall reconnect', async () => {
    let resolveBoard: ((value: ResolvedBoard) => void) | null = null;
    transport.resolveBoardForConfig.mockImplementationOnce(
      () =>
        new Promise<ResolvedBoard>((resolve) => {
          resolveBoard = resolve;
        }),
    );
    renderProvider();
    const args = { boardType: 'moonboard', layoutId: 1, sizeId: 1, setIds: '2019' };

    let firstPromise: Promise<BoardBindingIdentity | null> | undefined;
    let reconnectPromise: Promise<BoardBindingIdentity | null> | undefined;
    act(() => {
      firstPromise = capturedControls?.resolveAndBindBoardByConfig(args);
      reconnectPromise = capturedControls?.resolveAndBindBoardByConfig(args);
    });
    expect(transport.resolveBoardForConfig).toHaveBeenCalledTimes(1);

    let firstBinding: BoardBindingIdentity | null | undefined;
    let reconnectBinding: BoardBindingIdentity | null | undefined;
    await act(async () => {
      resolveBoard?.({ boardId: 43, boardName: 'MoonBoard 40' } as unknown as ResolvedBoard);
      [firstBinding, reconnectBinding] = await Promise.all([firstPromise, reconnectPromise]);
    });

    expect(firstBinding).toEqual({ boardId: 43 });
    expect(reconnectBinding).toEqual({ boardId: 43 });
  });

  it('ignores stale config resolve results after a newer selected config resolves', async () => {
    let resolveFirst: ((value: ResolvedBoard) => void) | null = null;
    let resolveSecond: ((value: ResolvedBoard) => void) | null = null;
    transport.resolveBoardForConfig.mockImplementation(
      (args: unknown) =>
        new Promise<ResolvedBoard>((resolve) => {
          const boardType = (args as { boardType: string }).boardType;
          if (boardType === 'moonboard') {
            resolveFirst = resolve;
            return;
          }
          resolveSecond = resolve;
        }),
    );
    renderProvider();

    let firstPromise: Promise<BoardBindingIdentity | null> | undefined;
    let secondPromise: Promise<BoardBindingIdentity | null> | undefined;
    act(() => {
      firstPromise = capturedControls?.resolveAndBindBoardByConfig({
        boardType: 'moonboard',
        layoutId: 1,
        sizeId: 1,
        setIds: '2019',
      });
      secondPromise = capturedControls?.resolveAndBindBoardByConfig({
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
      });
    });

    let invalidatedFirstResult: BoardBindingIdentity | null | undefined;
    await act(async () => {
      invalidatedFirstResult = await firstPromise;
    });
    expect(invalidatedFirstResult).toBeNull();

    await act(async () => {
      resolveSecond?.({ boardId: 44, boardName: 'Kilter' } as unknown as ResolvedBoard);
      await secondPromise;
    });
    await waitFor(() => {
      expect(sharedProvider.lastBoardId).toBe(44);
    });

    let firstResult: BoardBindingIdentity | null | undefined;
    await act(async () => {
      resolveFirst?.({ boardId: 43, boardName: 'MoonBoard 40' } as unknown as ResolvedBoard);
      firstResult = await firstPromise;
    });

    expect(firstResult).toBeNull();
    expect(sharedProvider.lastBoardId).toBe(44);
  });

  it('settles a pending resolution with null on reset and ignores its late result', async () => {
    let resolveBoard: ((value: ResolvedBoard) => void) | null = null;
    transport.resolveBoardForConfig.mockImplementationOnce(
      () =>
        new Promise<ResolvedBoard>((resolve) => {
          resolveBoard = resolve;
        }),
    );
    renderProvider();

    let bindingPromise: Promise<BoardBindingIdentity | null> | undefined;
    act(() => {
      bindingPromise = capturedControls?.resolveAndBindBoardByConfig({
        boardType: 'moonboard',
        layoutId: 1,
        sizeId: 1,
        setIds: '2019',
      });
      capturedControls?.resetPresence();
    });

    let binding: BoardBindingIdentity | null | undefined;
    await act(async () => {
      binding = await bindingPromise;
    });
    expect(binding).toBeNull();

    await act(async () => {
      resolveBoard?.({ boardId: 43, boardName: 'Late MoonBoard' } as unknown as ResolvedBoard);
    });
    expect(sharedProvider.lastBoardId).toBeNull();
  });

  it('clears the bound board while a different uuid resolve is pending', async () => {
    let resolveNext: ((value: ResolvedBoard) => void) | null = null;
    renderProvider();

    await act(async () => {
      await capturedControls?.resolveAndBindBoardByUuid({
        boardUuid: '11111111-1111-4111-8111-111111111111',
      });
    });
    await waitFor(() => {
      expect(sharedProvider.lastBoardId).toBe(44);
    });

    transport.resolveBoardForUuid.mockImplementationOnce(
      () =>
        new Promise<ResolvedBoard>((resolve) => {
          resolveNext = resolve;
        }),
    );

    act(() => {
      void capturedControls?.resolveAndBindBoardByUuid({
        boardUuid: '22222222-2222-4222-8222-222222222222',
      });
    });
    await waitFor(() => {
      expect(sharedProvider.lastBoardId).toBeNull();
    });

    await act(async () => {
      resolveNext?.({ boardId: 45, boardName: 'Next Board' } as unknown as ResolvedBoard);
    });
    await waitFor(() => {
      expect(sharedProvider.lastBoardId).toBe(45);
    });
  });

  it('ignores stale serial resolve results after a newer uuid resolve wins', async () => {
    let resolveSerial: ((value: ResolvedBoard) => void) | null = null;
    transport.resolveBoardForSerial.mockImplementationOnce(
      () =>
        new Promise<ResolvedBoard>((resolve) => {
          resolveSerial = resolve;
        }),
    );
    renderProvider();

    let serialPromise: Promise<BoardBindingIdentity | null> | undefined;
    await act(async () => {
      serialPromise = capturedControls?.resolveAndBindBoard({
        serial: 'SERIAL-1',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
      });
      await capturedControls?.resolveAndBindBoardByUuid({
        boardUuid: '11111111-1111-4111-8111-111111111111',
      });
    });
    await waitFor(() => {
      expect(sharedProvider.lastBoardId).toBe(44);
    });

    let serialResult: BoardBindingIdentity | null | undefined;
    await act(async () => {
      resolveSerial?.({ boardId: 42, boardName: 'Serial Board' } as unknown as ResolvedBoard);
      serialResult = await serialPromise;
    });

    expect(serialResult).toBeNull();
    expect(sharedProvider.lastBoardId).toBe(44);
  });

  it('returns null instead of leaking a rejected serial resolve', async () => {
    transport.resolveBoardCandidatesForSerial.mockRejectedValue(new Error('backend disabled'));
    renderProvider();

    await act(async () => {
      const resolved = await capturedControls?.resolveAndBindBoard({
        serial: 'SERIAL-1',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
      });
      expect(resolved).toBeNull();
    });

    expect(sharedProvider.lastBoardId).toBeNull();
  });

  it('reports directly to a resolved board id', async () => {
    renderProvider();

    await act(async () => {
      const accepted = await capturedControls?.reportClimbForBoard(
        42,
        { uuid: 'queue-1', climb: { uuid: 'climb-1' } } as ClimbQueueItemInput,
        40,
      );
      expect(accepted).toBe(true);
    });

    expect(transport.reportClimb).toHaveBeenCalledWith(42, { uuid: 'queue-1', climb: { uuid: 'climb-1' } }, 40);
  });

  it('catches up the wall feed when the app returns to the foreground', () => {
    renderProvider();
    expect(appState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    refreshMock.mockClear();
    act(() => appState.fire('active'));
    expect(refreshMock).toHaveBeenCalledWith('foreground');
  });

  it('does not catch up when the app goes to the background', () => {
    renderProvider();
    refreshMock.mockClear();
    act(() => appState.fire('background'));
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('tracks a catch-up telemetry event with the active boardId, reason, and recovered delta', async () => {
    renderProvider();
    await act(async () => {
      await capturedControls?.resolveAndBindBoard({
        serial: 'SERIAL-1',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
      });
    });
    await waitFor(() => expect(sharedProvider.lastBoardId).toBe(42));

    trackMock.mockClear();
    act(() => sharedProvider.lastOnCatchUp?.({ reason: 'reconnect', recoveredThroughSeqDelta: 2 }));

    expect(trackMock).toHaveBeenCalledWith('Board History Catch Up', {
      boardId: 42,
      reason: 'reconnect',
      recoveredThroughSeqDelta: 2,
    });
  });

  it('does not track catch-up telemetry when no wall events were recovered', async () => {
    renderProvider();
    await act(async () => {
      await capturedControls?.resolveAndBindBoard({
        serial: 'SERIAL-1',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
      });
    });
    await waitFor(() => expect(sharedProvider.lastBoardId).toBe(42));

    trackMock.mockClear();
    act(() => sharedProvider.lastOnCatchUp?.({ reason: 'foreground', recoveredThroughSeqDelta: 0 }));

    expect(trackMock).not.toHaveBeenCalledWith(SHARED_EVENTS.BoardHistoryCatchUp, expect.anything());
  });

  // Issue #4862. Every presence transport call — the subscription, each catch-up
  // fetch, the foreground refresh — goes through `getWsClient()`, which OPENS a
  // socket on demand, so the client the ConnectivityBridge disposes would come
  // straight back. A null client is the shared hook's inert state.
  it('hands the presence hook no transport while offline mode is on', () => {
    connectivity.offlineMode = true;

    renderProvider();

    expect(sharedProvider.lastClient).toBeNull();
  });

  it('keeps the transport attached when offline mode is off', () => {
    renderProvider();

    expect(sharedProvider.lastClient).not.toBeNull();
  });

  it('re-attaches the transport on the store edge back to online', () => {
    connectivity.offlineMode = true;
    const { rerender } = renderProvider();
    expect(sharedProvider.lastClient).toBeNull();

    connectivity.offlineMode = false;
    rerender(createElement(MobileBoardPresenceProvider, null, createElement(Probe)));

    expect(sharedProvider.lastClient).not.toBeNull();
  });
});
