// Thin React context over `useBoardPresence`, so consumers can read the wall's
// "now playing" state anywhere in the tree without prop-drilling. Renderer-
// agnostic — `react` only, no host components.

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  useBoardPresence,
  type BoardPresenceActions,
  type BoardPresenceCatchUpInfo,
  type BoardPresenceCurrentState,
  type BoardPresenceFeedState,
  type UseBoardPresenceResult,
} from './use-board-presence';
import type { BoardPresenceClient } from './types';
import type { BoardLayersSnapshot, BoardPresenceClimb } from '@boardsesh/shared-schema';

const BoardPresenceContext = createContext<UseBoardPresenceResult | undefined>(undefined);
const BoardPresenceActionsContext = createContext<BoardPresenceActions | undefined>(undefined);
const BoardPresenceCurrentContext = createContext<BoardPresenceCurrentState | undefined>(undefined);
const BoardPresenceFeedContext = createContext<BoardPresenceFeedState | undefined>(undefined);
const BoardPresenceLayersContext = createContext<BoardLayersSnapshot | null | undefined>(undefined);
// Presence-only boolean: true iff a wall feed is live with a current climb. A
// primitive, so consumers re-render only when the boolean flips (climb appears /
// disappears), NOT on every climb-to-climb change like `BoardPresenceCurrentContext`
// would. Mirrors how the mobile queue splits `useHasActiveClimb` from
// `useActiveClimbUuid` — lets chrome (tab tree, bottom-chrome metrics) gate on
// presence without re-rendering on every board-level climb change.
const BoardPresenceHasClimbContext = createContext<boolean | undefined>(undefined);
// Narrow selector: the wall's lit climb when live, else `null`. `undefined`
// means "outside the provider" (mirrors every other context here); `null` is a
// real value (no board bound, or the feed isn't live). Consumers that only
// need "what's lit right now" (e.g. mobile's `useWallClimbIfDistinct`) read
// this instead of `BoardPresenceCurrentContext`, so they don't re-render on
// holder/stats/undo-target churn that context also carries.
const BoardPresenceWallClimbContext = createContext<BoardPresenceClimb | null | undefined>(undefined);

/** The board + client pair a consumer needs to drive its own platform I/O
 * against — currently just `use-board-history-pagination`'s `fetchHistory`
 * paging, which lives outside the reducer/feed context on purpose (see that
 * hook's docstring). Memoized on `[boardId, client]` only, so it changes
 * exactly when the bound board or transport itself changes, never on a wall
 * event. */
export type BoardPresenceClientValue = {
  boardId: number | null;
  client: BoardPresenceClient | null;
};

const BoardPresenceClientContext = createContext<BoardPresenceClientValue | undefined>(undefined);

export function BoardPresenceProvider({
  boardId,
  client,
  onCatchUp,
  children,
}: {
  boardId: number | null;
  client: BoardPresenceClient | null;
  /**
   * Optional telemetry hook fired after a catch-up (reconnect / foreground /
   * gap / manual) completes — lets the platform measure how often live events
   * are silently dropped and recovered, without pulling analytics into this
   * renderer-agnostic package.
   */
  onCatchUp?: (info: BoardPresenceCatchUpInfo) => void;
  children: ReactNode;
}) {
  const value = useBoardPresence(boardId, client, onCatchUp);
  const actions = useMemo<BoardPresenceActions>(
    () => ({
      reportClimb: value.reportClimb,
      reportClimbWithUndoTarget: value.reportClimbWithUndoTarget,
      reportDisconnect: value.reportDisconnect,
      reportLayers: value.reportLayers,
      getUndoTarget: value.getUndoTarget,
      refresh: value.refresh,
    }),
    [
      value.reportClimb,
      value.reportClimbWithUndoTarget,
      value.reportDisconnect,
      value.reportLayers,
      value.getUndoTarget,
      value.refresh,
    ],
  );
  const current = useMemo<BoardPresenceCurrentState>(
    () => ({
      currentClimb: value.currentClimb,
      previousClimb: value.previousClimb,
      undoTarget: value.undoTarget,
      holder: value.holder,
      isLive: value.isLive,
    }),
    [value.currentClimb, value.previousClimb, value.undoTarget, value.holder, value.isLive],
  );
  const feed = useMemo<BoardPresenceFeedState>(
    () => ({
      history: value.history,
      stats: value.stats,
    }),
    [value.history, value.stats],
  );
  // Bare primitive on purpose — no useMemo. A boolean is compared by value, so
  // the context only re-renders consumers when it actually flips (not on every
  // currentClimb identity change). Wrapping it in useMemo would add nothing.
  const hasClimb = value.isLive && value.currentClimb !== null;
  // No useMemo here either — this value IS `value.currentClimb`'s own identity
  // when live (or the stable `null` literal otherwise), so there is nothing to
  // memoize: the reference only changes when `currentClimb` itself does.
  const wallClimb = value.isLive ? value.currentClimb : null;
  // Changes only on a board switch or client rebuild (props identity), never
  // on a wall event — safe for a hook like `use-board-history-pagination` to
  // key an effect on without re-running per climb.
  const clientValue = useMemo<BoardPresenceClientValue>(() => ({ boardId, client }), [boardId, client]);

  return (
    <BoardPresenceContext.Provider value={value}>
      <BoardPresenceActionsContext.Provider value={actions}>
        <BoardPresenceCurrentContext.Provider value={current}>
          <BoardPresenceHasClimbContext.Provider value={hasClimb}>
            <BoardPresenceWallClimbContext.Provider value={wallClimb}>
              <BoardPresenceFeedContext.Provider value={feed}>
                <BoardPresenceLayersContext.Provider value={value.layers}>
                  <BoardPresenceClientContext.Provider value={clientValue}>
                    {children}
                  </BoardPresenceClientContext.Provider>
                </BoardPresenceLayersContext.Provider>
              </BoardPresenceFeedContext.Provider>
            </BoardPresenceWallClimbContext.Provider>
          </BoardPresenceHasClimbContext.Provider>
        </BoardPresenceCurrentContext.Provider>
      </BoardPresenceActionsContext.Provider>
    </BoardPresenceContext.Provider>
  );
}

export function useBoardPresenceContext(): UseBoardPresenceResult {
  const context = useContext(BoardPresenceContext);
  if (context === undefined) {
    throw new Error('useBoardPresenceContext must be used within a BoardPresenceProvider');
  }
  return context;
}

export function useBoardPresenceActions(): BoardPresenceActions {
  const context = useContext(BoardPresenceActionsContext);
  if (context === undefined) {
    throw new Error('useBoardPresenceActions must be used within a BoardPresenceProvider');
  }
  return context;
}

export function useBoardPresenceCurrent(): BoardPresenceCurrentState {
  const context = useContext(BoardPresenceCurrentContext);
  if (context === undefined) {
    throw new Error('useBoardPresenceCurrent must be used within a BoardPresenceProvider');
  }
  return context;
}

export function useBoardPresenceFeed(): BoardPresenceFeedState {
  const context = useContext(BoardPresenceFeedContext);
  if (context === undefined) {
    throw new Error('useBoardPresenceFeed must be used within a BoardPresenceProvider');
  }
  return context;
}

/** Latest confirmed QuantumBoard roster without climb/history re-renders. */
export function useBoardPresenceLayers(): BoardLayersSnapshot | null {
  const context = useContext(BoardPresenceLayersContext);
  if (context === undefined) {
    throw new Error('useBoardPresenceLayers must be used within a BoardPresenceProvider');
  }
  return context;
}

export function useBoardPresenceHasClimb(): boolean {
  const context = useContext(BoardPresenceHasClimbContext);
  if (context === undefined) {
    throw new Error('useBoardPresenceHasClimb must be used within a BoardPresenceProvider');
  }
  return context;
}

/**
 * The wall's lit climb when the feed is live, else `null`. Narrower than
 * `useBoardPresenceCurrent()`: this context only changes when the lit climb
 * itself changes, not on holder/undo-target/isLive-independent churn, so
 * consumers that just need "what's on the wall right now" (e.g. mobile's
 * `useWallClimbIfDistinct`) avoid re-rendering on every presence event.
 */
export function useBoardPresenceWallClimb(): BoardPresenceClimb | null {
  const context = useContext(BoardPresenceWallClimbContext);
  if (context === undefined) {
    throw new Error('useBoardPresenceWallClimb must be used within a BoardPresenceProvider');
  }
  return context;
}

/**
 * The bound `boardId` + injected `client`, for consumers that need to drive
 * their own platform I/O against the same board/transport `useBoardPresence`
 * is attached to — e.g. `use-board-history-pagination`'s `fetchHistory`
 * paging. Prefer the narrower current/feed/actions hooks above for anything
 * that only reads wall state; this one exists for callers that need the raw
 * client.
 */
export function useBoardPresenceClient(): BoardPresenceClientValue {
  const context = useContext(BoardPresenceClientContext);
  if (context === undefined) {
    throw new Error('useBoardPresenceClient must be used within a BoardPresenceProvider');
  }
  return context;
}

export {
  BoardPresenceContext,
  BoardPresenceActionsContext,
  BoardPresenceCurrentContext,
  BoardPresenceFeedContext,
  BoardPresenceLayersContext,
  BoardPresenceHasClimbContext,
  BoardPresenceWallClimbContext,
  BoardPresenceClientContext,
};
