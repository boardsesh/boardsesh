'use client';

// Web BoardProvider. Mounts the platform adapter (auth, GraphQL clients,
// persistent-session, snackbar, tick-draft cleanup) and then delegates to
// the shared BoardProvider in `@boardsesh/board-react`. The data surface
// (logbook, saveTick, saveClimb, updateClimb) is implemented once in the
// shared package; this file is only the web-side wiring.

import type { ReactNode } from 'react';
import {
  BoardProvider as SharedBoardProvider,
  useBoardProvider as useSharedBoardProvider,
  useOptionalBoardProvider as useSharedOptionalBoardProvider,
  BoardContext,
  type BoardContextType as SharedBoardContextType,
} from '@boardsesh/board-react';
import type { BoardName } from '@/app/lib/types';
import { BoardAdapterWrapper } from './board-adapter';

// Web-side narrowing: web mounts BoardProvider with a concrete
// route-derived BoardName, never null. Consumers can rely on a non-null
// boardName without manual narrowing.
export type BoardContextType = Omit<SharedBoardContextType, 'boardName'> & { boardName: BoardName };

export { BoardContext };

export function BoardProvider({
  boardName,
  boardUuid,
  children,
}: {
  boardName: BoardName;
  /**
   * Active board entity UUID. Set by named-board routes (`/b/<slug>/...`) so
   * ticks attach to that exact board even when the climber doesn't own it
   * (e.g. a seeded gym board). Omit on the legacy config route, which doesn't
   * reference a specific board entity.
   */
  boardUuid?: string;
  children: ReactNode;
}) {
  return (
    <BoardAdapterWrapper>
      <SharedBoardProvider boardName={boardName} boardUuid={boardUuid}>
        {children}
      </SharedBoardProvider>
    </BoardAdapterWrapper>
  );
}

export function useBoardProvider(): BoardContextType {
  // Web always mounts BoardProvider with a non-null boardName, so the
  // narrower web context type holds at runtime. Cast at the boundary.
  return useSharedBoardProvider() as BoardContextType;
}

export function useOptionalBoardProvider(): BoardContextType | null {
  return useSharedOptionalBoardProvider() as BoardContextType | null;
}
