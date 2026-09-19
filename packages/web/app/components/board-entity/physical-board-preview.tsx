'use client';

import React, { useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { boardTypeLabel, convertLitUpHoldsStringToMap, toFlatFrames } from '@boardsesh/board-constants';
import { toBoardName } from '@boardsesh/board-config';
import type { BoardDiscoveryBoard } from '@boardsesh/shared-schema';
import BoardRenderer from '@/app/components/board-renderer/board-renderer';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import styles from './physical-board-preview.module.css';

/** Real catalogue geometry only. Missing/unsupported art remains a named board,
 * not a different manufacturer's stock diagram or a fabricated wall photo. */
export default function PhysicalBoardPreview({ board, label }: { board: BoardDiscoveryBoard; label: string }) {
  const artwork = useMemo(() => {
    try {
      const boardName = toBoardName(board.boardType);
      if (!boardName || boardName === 'spray') return null;
      const boardDetails = getBoardDetailsForBoard({
        board_name: boardName,
        layout_id: board.layoutId,
        size_id: board.sizeId,
        set_ids: board.setIds.split(',').map(Number),
      });
      const frames = board.currentClimb?.frames;
      const litUpHoldsMap = frames
        ? convertLitUpHoldsStringToMap(toFlatFrames(frames, boardName), boardName)[0]
        : undefined;
      return { boardDetails, litUpHoldsMap };
    } catch {
      return null;
    }
  }, [board.boardType, board.layoutId, board.sizeId, board.setIds, board.currentClimb?.frames]);

  return (
    <Box className={styles.preview} role="img" aria-label={label}>
      {artwork ? (
        <Box className={styles.artwork} aria-hidden>
          <BoardRenderer {...artwork} mirrored={false} thumbnail fillHeight />
        </Box>
      ) : (
        <Typography component="span" className={styles.fallback}>
          {boardTypeLabel(board.boardType)}
        </Typography>
      )}
    </Box>
  );
}
