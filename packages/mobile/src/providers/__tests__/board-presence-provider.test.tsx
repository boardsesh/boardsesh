// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { createElement, useEffect, type ReactNode } from 'react';
import type { ClimbQueueItemInput, ResolvedBoard } from '@boardsesh/shared-schema';

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
  lastOnCatchUp: undefined as ((info: { reason: string; recoveredThroughSeqDelta: number }) => void) | undefined,
}));
// The refresh action exposed by the (mocked) shared actions context, and a track
// spy — so we can assert the foreground sync and catch-up telemetry wiring.
const refreshMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
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

// Keep react-native host components (the disambiguation Modal) out of this
// jsdom suite — it asserts provider logic, not the picker UI.
vi.mock('../../components/board-discovery/BoardDisambiguationSheet', () => ({
  BoardDisambiguationSheet: () => null,
}));

// Capture the boardId handed to the shared provider so we can assert it updates
// after resolve.
vi.mock('@boardsesh/board-presence-react', () => ({
  BoardPresenceProvider: ({
    boardId,
    onCatchUp,
    children,
  }: {
    boardId: number | null;
    onCatchUp?: (info: { reason: string; recoveredThroughSeqDelta: number }) => void;
    children: ReactNode;
  }) => {
    sharedProvider.lastBoardId = boardId;
    sharedProvider.lastOnCatchUp = onCatchUp;
    return createElement('div', { 'data-board-id': String(boardId) }, children);
  },
  // BoardPresenceForegroundSync (rendered inside the provider) reads this.
  useBoardPresenceActions: () => ({ refresh: refreshMock }),
}));

import { MobileBoardPresenceProvider, useBoardPresenceControls } from '../board-presence-provider';

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
    sharedProvider.lastOnCatchUp = undefined;
    refreshMock.mockClear();
    trackMock.mockClear();
    appState.addEventListener.mockClear();
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
    await act(async () => {
      await capturedControls?.resolveAndBindBoard(args);
    });
    expect(transport.resolveBoardCandidatesForSerial).toHaveBeenCalledTimes(1);
  });

  it('does not bind a board when the serial maps to several candidates (awaits the pick)', async () => {
    transport.resolveBoardCandidatesForSerial.mockResolvedValue({
      board: null,
      candidates: [
        { boardId: 1, boardUuid: 'a', boardName: 'Home', boardType: 'kilter', isOwnedByMe: true, isPublic: false },
        { boardId: 2, boardUuid: 'b', boardName: 'Gym', boardType: 'kilter', isOwnedByMe: false, isPublic: true },
      ],
    } as unknown as { board: ResolvedBoard | null; candidates: unknown[] | null });
    renderProvider();

    await act(async () => {
      const resolved = await capturedControls?.resolveAndBindBoard({
        serial: 'SHARED-SERIAL',
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1,2',
      });
      // Ambiguous → no board bound yet; the user must pick via the prompt.
      expect(resolved).toBeNull();
    });
    expect(sharedProvider.lastBoardId).toBeNull();
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

  it('does not start a second uuid resolve while the same uuid is pending', async () => {
    let resolveBoard: ((value: ResolvedBoard) => void) | null = null;
    transport.resolveBoardForUuid.mockImplementationOnce(
      () =>
        new Promise<ResolvedBoard>((resolve) => {
          resolveBoard = resolve;
        }),
    );
    renderProvider();

    let firstPromise: Promise<ResolvedBoard | null> | undefined;
    act(() => {
      firstPromise = capturedControls?.resolveAndBindBoardByUuid({
        boardUuid: '11111111-1111-4111-8111-111111111111',
      });
    });

    let secondResult: ResolvedBoard | null | undefined;
    await act(async () => {
      secondResult = await capturedControls?.resolveAndBindBoardByUuid({
        boardUuid: '11111111-1111-4111-8111-111111111111',
      });
    });

    expect(secondResult).toBeNull();
    expect(transport.resolveBoardForUuid).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveBoard?.({ boardId: 44, boardName: 'Named Board' } as unknown as ResolvedBoard);
      await firstPromise;
    });
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
      expect(resolved).toBeNull();
    });
    expect(transport.resolveBoardForConfig).toHaveBeenCalledTimes(1);
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

    let firstPromise: Promise<ResolvedBoard | null> | undefined;
    let secondPromise: Promise<ResolvedBoard | null> | undefined;
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

    await act(async () => {
      resolveSecond?.({ boardId: 44, boardName: 'Kilter' } as unknown as ResolvedBoard);
      await secondPromise;
    });
    await waitFor(() => {
      expect(sharedProvider.lastBoardId).toBe(44);
    });

    let firstResult: ResolvedBoard | null | undefined;
    await act(async () => {
      resolveFirst?.({ boardId: 43, boardName: 'MoonBoard 40' } as unknown as ResolvedBoard);
      firstResult = await firstPromise;
    });

    expect(firstResult).toBeNull();
    expect(sharedProvider.lastBoardId).toBe(44);
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

    let serialPromise: Promise<ResolvedBoard | null> | undefined;
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

    let serialResult: ResolvedBoard | null | undefined;
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
});
