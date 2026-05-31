'use client';

// Thin web binding over the shared `@boardsesh/board-react` climb hooks. The
// mutation logic lives in the shared package; web-only I/O (auth, WS GraphQL
// client, snackbar, i18n) is injected via the web deps builders.
// `SaveClimbResponse` / `UpdateClimbResponse` are re-exported for existing imports.

import type { BoardName } from '@/app/lib/types';
import { useSaveClimb as useSharedSaveClimb, useUpdateClimb as useSharedUpdateClimb } from '@boardsesh/board-react';
import { useWebSaveClimbDeps, useWebUpdateClimbDeps } from '@/app/components/board-provider/web-board-data-deps';

export type { SaveClimbResponse, UpdateClimbResponse } from '@boardsesh/board-react';

/** Hook to save a new climb via GraphQL mutation. */
export function useSaveClimb(boardName: BoardName) {
  const deps = useWebSaveClimbDeps();
  return useSharedSaveClimb(deps, boardName);
}

/**
 * Hook to update an existing climb. Only the climb's owner may call this, and
 * only while the climb is still a draft or within 24h of first publish. The
 * backend enforces both rules.
 */
export function useUpdateClimb() {
  const deps = useWebUpdateClimbDeps();
  return useSharedUpdateClimb(deps);
}
