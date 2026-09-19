'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import { boardTypeLabel } from '@boardsesh/board-constants';
import type { BoardDiscoveryBoard } from '@boardsesh/shared-schema';
import LocaleLink from '@/app/components/i18n/locale-link';
import { sectionHeadingTypeClassName } from '@/app/components/ui/page-shell';
import { APP_URL } from '@/app/lib/app-origin';
import PhysicalBoardPreview from './physical-board-preview';
import styles from './popular-board-rail.module.css';

/** Named physical installations, ranked by board-local climbers on the backend.
 * Public links retain the slug; the app action opens that same existing UUID.
 * Neither path offers a generic configuration or creates a replacement board. */
export default function PopularBoardRail({ boards }: { boards: BoardDiscoveryBoard[] }) {
  const { t, i18n } = useTranslation('marketing');
  if (boards.length === 0) return null;
  const numberFormat = new Intl.NumberFormat(i18n.language);

  return (
    <Box component="section" className={styles.section} data-testid="physical-board-rail">
      <Typography variant="h3" component="h2" className={`${sectionHeadingTypeClassName} ${styles.title}`}>
        {t('home.boards.title')}
      </Typography>
      <Typography component="p" className={styles.lead}>
        {t('home.boards.lead')}
      </Typography>
      <Box component="ul" className={styles.grid}>
        {boards.map((board) => {
          const boardPath = `/b/${encodeURIComponent(board.slug)}`;
          const previewAngle = board.currentClimb?.angle ?? board.angle;
          const appPath = `${boardPath}/${previewAngle}/list`;
          /* Plenty of boards are named after the gym they live in, and printing
             the same words twice reads as a bug. The gym link is the card's only
             /gym/ anchor either way, so relabel it with the location when the
             two names match rather than dropping the second line. */
          const gymLabel = board.gymName === board.name ? (board.locationName ?? board.gymName) : board.gymName;
          return (
            <Box component="li" key={board.uuid} className={styles.card}>
              <Box className={styles.identity}>
                <Typography component="h3" className={styles.name}>
                  <MuiLink component={LocaleLink} href={boardPath} underline="hover" color="inherit">
                    {board.name}
                  </MuiLink>
                </Typography>
                <MuiLink
                  component={LocaleLink}
                  href={`/gym/${encodeURIComponent(board.gymSlug)}`}
                  underline="hover"
                  className={styles.gym}
                >
                  {gymLabel}
                </MuiLink>
                {board.locationName && board.locationName !== gymLabel && (
                  <Typography component="p" className={styles.location}>
                    {board.locationName}
                  </Typography>
                )}
              </Box>
              <PhysicalBoardPreview board={board} label={t('home.boards.preview', { board: board.name })} />
              <Box className={styles.details}>
                <Typography component="p" className={styles.meta}>
                  {t('home.boards.typeAngle', {
                    board: boardTypeLabel(board.boardType),
                    angle: previewAngle,
                  })}
                </Typography>
                {board.uniqueClimbers > 0 && (
                  <Typography component="p" className={styles.meta}>
                    {t('home.boards.climbers', {
                      count: board.uniqueClimbers,
                      formattedCount: numberFormat.format(board.uniqueClimbers),
                    })}
                  </Typography>
                )}
                {board.currentClimb?.name && (
                  <Typography component="p" className={styles.selection}>
                    {t('home.boards.selectedClimb', { climb: board.currentClimb.name })}
                  </Typography>
                )}
              </Box>
              <Button href={`${APP_URL}${appPath}`} variant="outlined" className={styles.open}>
                {t('home.boards.open')}
              </Button>
            </Box>
          );
        })}
      </Box>
      <Typography component="p" className={styles.ranking}>
        {t('home.boards.ranking')}
      </Typography>
    </Box>
  );
}
