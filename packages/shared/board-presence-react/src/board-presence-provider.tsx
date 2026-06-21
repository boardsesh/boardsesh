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

const BoardPresenceContext = createContext<UseBoardPresenceResult | undefined>(undefined);
const BoardPresenceActionsContext = createContext<BoardPresenceActions | undefined>(undefined);
const BoardPresenceCurrentContext = createContext<BoardPresenceCurrentState | undefined>(undefined);
const BoardPresenceFeedContext = createContext<BoardPresenceFeedState | undefined>(undefined);
// Presence-only boolean: true iff a wall feed is live with a current climb. A
// primitive, so consumers re-render only when the boolean flips (climb appears /
// disappears), NOT on every climb-to-climb change like `BoardPresenceCurrentContext`
// would. Mirrors how the mobile queue splits `useHasActiveClimb` from
// `useActiveClimbUuid` — lets chrome (tab tree, bottom-chrome metrics) gate on
// presence without re-rendering on every board-level climb change.
const BoardPresenceHasClimbContext = createContext<boolean | undefined>(undefined);

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
      getUndoTarget: value.getUndoTarget,
      refresh: value.refresh,
    }),
    [value.reportClimb, value.reportClimbWithUndoTarget, value.reportDisconnect, value.getUndoTarget, value.refresh],
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

  return (
    <BoardPresenceContext.Provider value={value}>
      <BoardPresenceActionsContext.Provider value={actions}>
        <BoardPresenceCurrentContext.Provider value={current}>
          <BoardPresenceHasClimbContext.Provider value={hasClimb}>
            <BoardPresenceFeedContext.Provider value={feed}>{children}</BoardPresenceFeedContext.Provider>
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

export function useBoardPresenceHasClimb(): boolean {
  const context = useContext(BoardPresenceHasClimbContext);
  if (context === undefined) {
    throw new Error('useBoardPresenceHasClimb must be used within a BoardPresenceProvider');
  }
  return context;
}

export {
  BoardPresenceContext,
  BoardPresenceActionsContext,
  BoardPresenceCurrentContext,
  BoardPresenceFeedContext,
  BoardPresenceHasClimbContext,
};
