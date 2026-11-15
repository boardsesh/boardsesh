import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchAllMyBoards } from '../../lib/graphql/hooks';
import { useActiveBoard, useSetActiveBoard } from '../../lib/graphql/use-active-board';
import { useAuth } from '../../providers/auth-provider';
import { matchScreenshotBoardCandidates } from './screenshot-board-matching';
import { boardSelectors } from './config';
import { reportScreenshotSmokeError } from './screenshot-smoke';

/** Selects a real owned board through the same public action as the board picker. */
export function IntegrationBoardSetup(): null {
  const { isAuthenticated } = useAuth();
  const { data: activeBoard, isPending } = useActiveBoard();
  const activate = useSetActiveBoard();
  const attempted = useRef<string | null>(null);
  const boards = useQuery({
    queryKey: ['integrationOwnedBoards'],
    queryFn: fetchAllMyBoards,
    enabled: isAuthenticated,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (!isAuthenticated || isPending || !boards.data) return;
    const selector = boardSelectors[0];
    const candidates = selector ? matchScreenshotBoardCandidates(boards.data, selector) : [];
    if (candidates.length !== 1) {
      if (attempted.current !== 'invalid')
        reportScreenshotSmokeError(
          new Error(`Integration board selector must match exactly one owned board (matched ${candidates.length})`),
        );
      attempted.current = 'invalid';
      return;
    }
    const board = candidates[0];
    if (attempted.current === board.uuid) return;
    attempted.current = board.uuid;
    // An already-selected starting board completes setup too. Later picker
    // interactions belong to the recording, not to this initializer.
    if (activeBoard?.uuid === board.uuid) return;
    void activate(board).catch((error) => {
      attempted.current = null;
      reportScreenshotSmokeError(error instanceof Error ? error : new Error('Board setup failed'));
    });
  }, [isAuthenticated, isPending, boards.data, activeBoard, activate]);
  return null;
}
