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
import { buildCanonicalClimbViewUrl } from '@/app/lib/url-utils';
import { themeTokens } from '@/app/theme/theme-config';
import type { BoardDetails, Climb } from '@/app/lib/types';

/**
 * One crawlable climb row: a real `<a href>` to the canonical config-tuple
 * view URL, wrapping the thumbnail, the title block and nothing else.
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
  boardDetails: BoardDetails;
  /** Current pathname, forwarded to ClimbThumbnail (it takes it as a prop rather than calling usePathname per row). */
  pathname: string;
  /** Viewer's ticks for the ascent badge. Absent on anonymous/crawler renders. */
  logbook?: readonly LogbookEntry[];
  preferImageLayers?: boolean;
  fetchPriority?: 'high' | 'low' | 'auto';
  /** Extra content under the title, inside the link (e.g. a playlist note). */
  centerBottomSlot?: React.ReactNode;
};

// Reproduces climb-list-item's row geometry exactly: 64px thumbnail at
// aspect-ratio 5/7 ≈ 89.6px, plus 2 × 8px padding and a 1px border ≈ 106.6px,
// which is the LIST_ROW_HEIGHT (107) the virtualizer estimates with. A row that
// measures anything else reflows every row beneath it on mount (issue #3086).
const rowLinkSx = {
  display: 'block',
  color: 'inherit',
  textDecoration: 'none',
  '&:hover': { backgroundColor: 'var(--semantic-selected-light)' },
} as const;

const rowSx = {
  display: 'flex',
  alignItems: 'center',
  padding: `${themeTokens.spacing[2]}px`,
  gap: `${themeTokens.spacing[3]}px`,
  borderBottom: '1px solid var(--border-subtle)',
} as const;

const thumbnailSx = {
  width: `${themeTokens.spacing[16]}px`,
  flexShrink: 0,
  position: 'relative',
} as const;

const centerSx = { flex: 1, minWidth: 0 } as const;

const StaticClimbRow = ({
  climb,
  boardDetails,
  pathname,
  logbook,
  preferImageLayers,
  fetchPriority,
  centerBottomSlot,
}: StaticClimbRowProps) => {
  const href = useMemo(
    () => buildCanonicalClimbViewUrl(boardDetails, climb.angle, climb.uuid, climb.name),
    [boardDetails, climb.angle, climb.uuid, climb.name],
  );

  return (
    // prefetch={false} is load-bearing: ~18 rows are in the virtualizer's
    // window at any moment, and the App Router default would fire a route
    // prefetch for every one of them on a page that already carries its own
    // data fetch.
    <MuiLink component={LocaleLink} href={href} prefetch={false} underline="none" color="inherit" sx={rowLinkSx}>
      <Box sx={rowSx}>
        <Box sx={thumbnailSx} data-testid="climb-thumbnail">
          <ClimbThumbnail
            boardDetails={boardDetails}
            currentClimb={climb}
            pathname={pathname}
            preferImageLayers={preferImageLayers}
            fetchPriority={fetchPriority}
          />
          <AscentStatus
            climbUuid={climb.uuid}
            angle={climb.angle}
            logbook={logbook}
            boardName={boardDetails.board_name}
            fontSize={12}
            className={ascentStyles.badge}
            mirroredClassName={ascentStyles.badgeMirrored}
          />
        </Box>
        <Box sx={centerSx}>
          <ClimbTitle
            climb={climb}
            gradePosition="right"
            showSetterInfo
            titleFontSize={themeTokens.typography.fontSize.xl}
            isNoMatch={!!climb.is_no_match}
          />
          {centerBottomSlot}
        </Box>
      </Box>
    </MuiLink>
  );
};

export default React.memo(StaticClimbRow);
