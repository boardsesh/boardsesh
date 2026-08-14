'use client';

import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import LocaleLink from '@/app/components/i18n/locale-link';
import BoardRenderer from '@/app/components/board-renderer/board-renderer';
import { getBoardDetailsForBoard } from '@/app/lib/board-utils';
import { getDefaultAngleForBoard } from '@/app/lib/board-config-for-playlist';
import { popularConfigListUrl } from '@/app/lib/url-utils';
import { formatCount } from '@/app/lib/format-climb-stats';
import type { BoardDetails, BoardName } from '@/app/lib/types';
import type { PopularBoardConfig } from '@boardsesh/shared-schema';
import styles from './popular-board-rail.module.css';

/**
 * The home page's board rail: one real `<a href>` per popular config, server
 * rendered.
 *
 * Deliberately not wrapped in `dynamic(…, { ssr: false })` and not gated on a
 * client-only hook — SSR-emitted anchors are the whole point. The homepage is
 * the strongest internal-link source www has, and until this shipped there was
 * no crawlable path from `/` to any board's climbs at all.
 *
 * `displayName` is the anchor text, so no `aria-label` and no `title`: either
 * would override richer text a crawler and a screen reader both already get.
 */

function resolveBoardDetails(config: PopularBoardConfig): BoardDetails | null {
  try {
    return getBoardDetailsForBoard({
      board_name: config.boardType as BoardName,
      layout_id: config.layoutId,
      size_id: config.sizeId,
      set_ids: config.setIds,
    });
  } catch {
    // A config the static hold tables don't resolve (a new layout, a size the
    // generated data hasn't caught up with) drops out of the rail rather than
    // taking the whole homepage down with it.
    return null;
  }
}

export type PopularBoardRailProps = {
  configs: PopularBoardConfig[];
};

export default function PopularBoardRail({ configs }: PopularBoardRailProps) {
  const { t } = useTranslation('boards');

  // Resolve first, render second. `getPopularBoardConfigs()` returns [] when the
  // backend is unreachable, and a config the static hold tables don't resolve
  // drops out one by one — so the guard counts the cards that will actually
  // paint, not the configs that came in. Guarding on the input array would ship
  // a lone section heading over an empty grid the day every config drops.
  const cards = configs.flatMap((config) => {
    const boardDetails = resolveBoardDetails(config);
    return boardDetails ? [{ config, boardDetails }] : [];
  });

  if (cards.length === 0) return null;

  return (
    <Box component="section">
      <Typography variant="body2" component="h2" className={styles.title}>
        {t('discovery.popular.title')}
      </Typography>
      <div className={styles.grid}>
        {cards.map(({ config, boardDetails }) => {
          const href = popularConfigListUrl(config, getDefaultAngleForBoard(config.boardType));
          return (
            <MuiLink
              key={`${config.boardType}-${config.layoutId}-${config.sizeId}-${config.setIds.join(',')}`}
              component={LocaleLink}
              href={href}
              prefetch={false}
              underline="none"
              color="inherit"
              className={styles.card}
            >
              <div className={styles.thumb}>
                <BoardRenderer mirrored={false} boardDetails={boardDetails} thumbnail fillHeight />
              </div>
              <div className={styles.name}>{config.displayName}</div>
              <div className={styles.meta}>
                {t('discovery.popular.meta', {
                  boards: formatCount(config.boardCount),
                  sends: formatCount(config.totalAscents),
                })}
              </div>
            </MuiLink>
          );
        })}
      </div>
    </Box>
  );
}
