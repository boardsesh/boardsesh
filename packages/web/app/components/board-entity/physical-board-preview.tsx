'use client';

import React, { useCallback, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { boardTypeLabel } from '@boardsesh/board-constants/board-type-labels';
import { toFlatFrames } from '@boardsesh/board-constants/hold-states';
import { SUPPORTED_BOARDS, type BoardDiscoveryBoard } from '@boardsesh/shared-schema';
import { buildBoardRenderUrl, hasDarkBoardArt } from '@/app/components/board-renderer/util';
import { getBoardImageDetailsForBoard } from '@/app/lib/board-image-details';
import styles from './physical-board-preview.module.css';

/** Backend-rendered catalogue art only. Missing/unsupported art remains a named board,
 * not a different manufacturer's stock diagram or a fabricated wall photo. */
export default function PhysicalBoardPreview({ board, label }: { board: BoardDiscoveryBoard; label: string }) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const artwork = useMemo(() => {
    try {
      const boardName = SUPPORTED_BOARDS.find((supportedBoard) => supportedBoard === board.boardType);
      if (!boardName || boardName === 'spray') return null;
      const boardDetails = getBoardImageDetailsForBoard({
        board_name: boardName,
        layout_id: board.layoutId,
        size_id: board.sizeId,
        set_ids: board.setIds.split(',').map(Number),
      });
      return {
        url: buildBoardRenderUrl(boardDetails, toFlatFrames(board.currentClimb?.frames ?? '', boardName), {
          thumbnail: true,
          includeBackground: true,
          colorScheme: hasDarkBoardArt(boardName) ? 'dark' : undefined,
        }),
      };
    } catch {
      return null;
    }
  }, [board.boardType, board.layoutId, board.sizeId, board.setIds, board.currentClimb?.frames]);

  const handleImageError = useCallback(() => {
    if (artwork) setFailedImageUrl(artwork.url);
  }, [artwork]);

  return (
    <Box className={styles.preview} role="img" aria-label={label}>
      {artwork && artwork.url !== failedImageUrl ? (
        <Box className={styles.artwork} aria-hidden>
          <Box
            component="img"
            className={styles.image}
            src={artwork.url}
            alt=""
            loading="lazy"
            onError={handleImageError}
          />
        </Box>
      ) : (
        <Typography component="span" className={styles.fallback}>
          {boardTypeLabel(board.boardType)}
        </Typography>
      )}
    </Box>
  );
}
