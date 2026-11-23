'use client';

import React, { useMemo } from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import type { LogbookEntry } from '@boardsesh/board-react';
import LocaleLink from '@/app/components/i18n/locale-link';
import ClimbThumbnail from '@/app/components/climb-card/climb-thumbnail';
import ClimbTitle from '@/app/components/climb-card/climb-title';
import { AscentStatus } from '@/app/components/climb-card/ascent-status';
import ascentStyles from '@/app/components/climb-card/ascent-status.module.css';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import { buildCanonicalClimbViewUrl, constructBoardSlugViewUrl } from '@/app/lib/url-utils';
import { themeTokens } from '@/app/theme/theme-config';
import styles from './static-climb-row.module.css';
import type { BoardImageDetails, Climb } from '@/app/lib/types';
import type { ClimbThumbnailCrop } from '@/app/lib/climb-thumbnail-crop';

/**
 * One crawlable climb row. Ordinary discovery uses the canonical config-tuple
 * URL; named-board pages explicitly retain their physical-board identity.
 *
 * Lives in its own module rather than inside `static-climb-list.tsx` so
 * `social/proposal-card.tsx` — which renders exactly one climb inside
 * `/gym/[gym_slug]` — can import the row without pulling `@tanstack/react-virtual`
 * into that page's bundle.
 *
 * Exactly one interactive element per row, on purpose. No onClick, no swipe
 * actions, no overflow menu: nesting a button inside an anchor is invalid HTML
 * and makes the row unusable from the keyboard, and the interactive versions of
 * all three live in the app.
 */
export type StaticClimbRowProps = {
  climb: Climb;
  thumbnailCrop?: ClimbThumbnailCrop;
  boardDetails: BoardImageDetails;
  /** Keep named-wall discovery on that physical board, not a new config. */
  boardSlug?: string;
  /**
   * Renders the row without its anchor, for a climb with no resolvable
   * canonical URL — a session tick the catalog lookup missed has no name,
   * layout or frames, so both the board and the slug in a link would be
   * invented. A plain row beats a link to a climb that doesn't resolve.
   */
  unlinked?: boolean;
  /** Current pathname, forwarded to ClimbThumbnail (it takes it as a prop rather than calling usePathname per row). */
  pathname: string;
  /** Viewer's ticks for the ascent badge. Absent on anonymous/crawler renders. */
  logbook?: readonly LogbookEntry[];
  fetchPriority?: 'high' | 'low' | 'auto';
  /**
   * `list` (default): a full-width row over a hairline. `card`: the app's row,
   * a rounded card with the grade on a chip in its grade colour.
   */
  variant?: StaticClimbRowVariant;
  /** Name the setter in the byline (default). Off on a page that is already one setter's. */
  showSetter?: boolean;
  /** Add the angle the row links to, for a list whose climbs sit at different angles. */
  showAngle?: boolean;
};

export type StaticClimbRowVariant = 'list' | 'card';

// The 72px/88px responsive preview determines the natural row height. The
// virtual window keeps adjacent rows in normal flow until it can measure them.
const rowLinkSx = {
  display: 'block',
  color: 'inherit',
  textDecoration: 'none',
  '&:hover': { backgroundColor: 'var(--semantic-hover)' },
} as const;

// Same geometry as the linked row, minus the hover affordance: nothing happens
// when this one is clicked.
const unlinkedRowSx = { display: 'block', color: 'inherit' } as const;

const rowSx = {
  display: 'flex',
  alignItems: 'center',
  padding: `${themeTokens.spacing[2]}px`,
  gap: `${themeTokens.spacing[3]}px`,
  borderBottom: '1px solid var(--border-subtle)',
} as const;

const thumbnailSx = {
  flexShrink: 0,
  position: 'relative',
} as const;

const centerSx = { flex: 1, minWidth: 0 } as const;

// The card's hover lives on the card itself, not on the anchor around it: the
// anchor is a square box, and a square highlight behind a rounded card shows
// its corners.
const cardRowSx = {
  ...rowSx,
  borderBottom: 'none',
  borderRadius: `${themeTokens.borderRadius.lg}px`,
  backgroundColor: 'var(--semantic-surface)',
} as const;

const cardLinkSx = {
  display: 'block',
  color: 'inherit',
  textDecoration: 'none',
  borderRadius: `${themeTokens.borderRadius.lg}px`,
  '&:hover > div': { backgroundColor: 'var(--semantic-surface-elevated)' },
} as const;

const cardUnlinkedSx = {
  display: 'block',
  color: 'inherit',
  borderRadius: `${themeTokens.borderRadius.lg}px`,
} as const;

const StaticClimbRow = ({
  climb,
  boardDetails,
  boardSlug,
  unlinked,
  pathname,
  logbook,
  fetchPriority,
  thumbnailCrop,
  variant = 'list',
  showSetter = true,
  showAngle = false,
}: StaticClimbRowProps) => {
  const isCard = variant === 'card';
  const href = useMemo(
    () =>
      unlinked
        ? null
        : // `resolveClimbDisplayName`, not the raw name. An unnamed climb's own
          // canonical carries the `-{board} Climb-` slug, and so does its sitemap
          // URL; a row anchor built from the raw null would be a THIRD URL for
          // one page, splitting the signal three ways.
          boardSlug
          ? constructBoardSlugViewUrl(
              encodeURIComponent(boardSlug),
              climb.angle,
              climb.uuid,
              resolveClimbDisplayName(climb.name, boardDetails.board_name),
            )
          : buildCanonicalClimbViewUrl(
              boardDetails,
              climb.angle,
              climb.uuid,
              resolveClimbDisplayName(climb.name, boardDetails.board_name),
            ),
    [unlinked, boardSlug, boardDetails, climb.angle, climb.uuid, climb.name],
  );

  const rowBody = (
    <Box sx={isCard ? cardRowSx : rowSx}>
      <Box
        sx={thumbnailSx}
        className={isCard ? `${styles.thumbnail} ${styles.thumbnailCompact}` : styles.thumbnail}
        data-testid="climb-thumbnail"
      >
        <ClimbThumbnail
          boardDetails={boardDetails}
          currentClimb={climb}
          pathname={pathname}
          fetchPriority={fetchPriority}
          crop={thumbnailCrop}
        />
        <AscentStatus
          climbUuid={climb.uuid}
          angle={climb.angle}
          logbook={logbook}
          boardName={boardDetails.board_name}
          layoutId={boardDetails.layout_id}
          fontSize={12}
          className={ascentStyles.badge}
          mirroredClassName={ascentStyles.badgeMirrored}
        />
      </Box>
      <Box sx={centerSx}>
        {/* showGradeWhileLoading is load-bearing for the crawl: the reader's
            grade format resolves from IndexedDB inside an effect, so without
            it the server HTML carries a Skeleton where the grade belongs. */}
        <ClimbTitle
          climb={climb}
          gradePosition="right"
          ellipsis
          showSetterInfo={showSetter}
          showAngle={showAngle}
          gradeDisplay={isCard ? 'chip' : 'text'}
          showGradeWhileLoading
          titleFontSize={themeTokens.typography.fontSize.xl}
          isNoMatch={!!climb.is_no_match}
        />
      </Box>
    </Box>
  );

  // Null href means `unlinked` — checking it here rather than the flag is what
  // narrows `href` to a string for the anchor below.
  if (href === null) {
    return <Box sx={isCard ? cardUnlinkedSx : unlinkedRowSx}>{rowBody}</Box>;
  }

  return (
    // prefetch={false} is load-bearing: ~18 rows are in the virtualizer's
    // window at any moment, and the App Router default would fire a route
    // prefetch for every one of them on a page that already carries its own
    // data fetch.
    <MuiLink
      component={LocaleLink}
      href={href}
      prefetch={false}
      underline="none"
      color="inherit"
      sx={isCard ? cardLinkSx : rowLinkSx}
    >
      {rowBody}
    </MuiLink>
  );
};

export default React.memo(StaticClimbRow);
