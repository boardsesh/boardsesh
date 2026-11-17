import { useEffect } from 'react';
import type { BoardName, UserBoard } from '@boardsesh/shared-schema';
import type { BoardSearchConfig } from '@boardsesh/climb-filters';
import { scheduleIdleTask } from '../../lib/schedule-idle-task';
import { parseSetIdsParam, prewarmCreateBoardHolds } from '../../lib/create-board-holds';
import { ensureBackgroundsCached, type BackgroundColorScheme } from '../../lib/background-image-cache';

const PREWARM_BOARD_HOLDS_DELAY_MS = 1200;

/** Cancel queued board-art work when its board, readiness, or theme changes. */
export function useClimbBoardPrewarming({
  boardConfig,
  searchReady,
  activeBoard,
  colorScheme,
}: {
  boardConfig: BoardSearchConfig | null;
  searchReady: boolean;
  activeBoard: UserBoard | null | undefined;
  colorScheme: BackgroundColorScheme;
}) {
  useEffect(() => {
    if (!boardConfig || !searchReady) return;
    let task: ReturnType<typeof scheduleIdleTask> | null = null;
    const timeout = setTimeout(() => {
      task = scheduleIdleTask(() => {
        prewarmCreateBoardHolds({
          boardName: boardConfig.boardName as BoardName,
          layoutId: boardConfig.layoutId,
          sizeId: boardConfig.sizeId,
          setIds: parseSetIdsParam(boardConfig.setIds),
        });
      });
    }, PREWARM_BOARD_HOLDS_DELAY_MS);
    return () => {
      clearTimeout(timeout);
      task?.cancel();
    };
  }, [boardConfig, searchReady]);

  // Pre-warm bundled board backgrounds so the first tap into a climb paints
  // instantly. Backgrounds are bundled file:// assets — never fetch board art
  // over HTTP (the production CDN/WAF 403s the app's request).
  useEffect(() => {
    if (!activeBoard) return;
    const task = scheduleIdleTask(() => {
      const parsedSetIds = activeBoard.setIds.split(',').map(Number);
      void ensureBackgroundsCached({
        boardName: activeBoard.boardType as BoardName,
        layoutId: activeBoard.layoutId,
        sizeId: activeBoard.sizeId,
        setIds: parsedSetIds,
        colorScheme,
      });
    });
    return () => {
      task.cancel();
    };
  }, [activeBoard, colorScheme]);
}
