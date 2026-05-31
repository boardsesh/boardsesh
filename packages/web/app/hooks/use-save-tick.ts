'use client';

// Thin web binding over the shared `@boardsesh/board-react` tick-save hook. The
// optimistic accumulated-cache logic lives in the shared package; web-only I/O
// (auth, HTTP GraphQL client, IndexedDB draft clear) is injected via
// `useWebSaveTickDeps`. `SaveTickOptions` is re-exported for existing imports.

import type { BoardName } from '@/app/lib/types';
import { useSaveTick as useSharedSaveTick } from '@boardsesh/board-react';
import { useWebSaveTickDeps } from '@/app/components/board-provider/web-board-data-deps';

export type { SaveTickOptions } from '@boardsesh/board-react';

/**
 * Hook to save a tick (logbook entry) via GraphQL mutation, with optimistic
 * updates against the accumulated logbook cache.
 */
export function useSaveTick(boardName: BoardName) {
  const deps = useWebSaveTickDeps();
  return useSharedSaveTick(deps, boardName);
}
