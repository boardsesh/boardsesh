'use client';

import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import { boardTypeLabel } from '@boardsesh/board-constants';
import type { BoardDiscoveryBoard } from '@boardsesh/shared-schema';
import LocaleLink from '@/app/components/i18n/locale-link';
import { APP_URL } from '@/app/lib/app-origin';
import PhysicalBoardPreview from './physical-board-preview';
import styles from './physical-board-preview.module.css';

/** Optional homepage enhancement. An ordinary directory card needs neither
 * these snapshots nor the marketing translation namespace. */
export default function GymBoardPreviews({ boards }: { boards: BoardDiscoveryBoard[] }) {
  const { t } = useTranslation('marketing');
  return (
    <Box component="ul" className={styles.gymPreviews} data-testid="gym-board-previews">
      {boards.slice(0, 3).map((board) => {
        const boardPath = `/b/${encodeURIComponent(board.slug)}`;
        const previewAngle = board.currentClimb?.angle ?? board.angle;
        return (
          <Box component="li" key={board.uuid} className={styles.gymBoard}>
            <MuiLink component={LocaleLink} href={boardPath} underline="hover" className={styles.gymBoardLink}>
              <PhysicalBoardPreview board={board} label={t('home.boards.preview', { board: board.name })} compact />
              <Typography component="span" className={styles.gymBoardName}>
                {board.name}
              </Typography>
            </MuiLink>
            <Typography component="p" className={styles.gymBoardMeta}>
              {t('home.boards.typeAngle', {
                board: boardTypeLabel(board.boardType),
                angle: previewAngle,
              })}
            </Typography>
            <MuiLink
              href={`${APP_URL}${boardPath}/${previewAngle}/list`}
              className={styles.gymBoardOpen}
              underline="hover"
            >
              {t('home.boards.open')}
            </MuiLink>
          </Box>
        );
      })}
    </Box>
  );
}
