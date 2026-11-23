import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { visuallyHidden } from '@mui/utils';
import GradeTile from '@/app/components/climb-front-door/grade-tile';
import { formatQualityAverage } from '@/app/components/climb-front-door/climb-facts-format';
import { frontDoorTitleSx } from '@/app/components/climb-front-door/front-door-heading-sx';
import { normalizedQuality } from '@/app/lib/climb-quality';
import LocaleLink from '@/app/components/i18n/locale-link';
import { climbBoardForSearch, climbGradeForSearch } from '@/app/lib/seo/climb-display';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { fillNodeSlot, nodeSlot } from '@/app/lib/i18n/node-slot';
import { formatBoardDisplayName } from '@/app/lib/string-utils';
import { themeTokens } from '@/app/theme/theme-config';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { BoardRouteIdentity, Climb } from '@/app/lib/types';

type ClimbViewSeoFragmentProps = {
  climb: Climb;
  boardDetails: BoardRouteIdentity;
  angle?: number;
  /** The stats row for the angle being viewed, when there is one. Carries the quality. */
  currentAngleStats?: ClimbStatsForAngle;
};

// Name on the left, grade tile on the right. Below md the tile sits beside the
// name only and the proof lines run the full width under both; from md it
// spans the heading and both lines.
const headerSx = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  columnGap: { xs: `${themeTokens.spacing[3]}px`, md: `${themeTokens.spacing[6]}px` },
  alignItems: 'start',
};

const headingSx = {
  ...frontDoorTitleSx,
  gridColumn: 1,
  gridRow: 1,
  alignSelf: { xs: 'center', md: 'start' },
  margin: 0,
  // Breaks inside a word only when the word alone is wider than the column.
  overflowWrap: 'break-word' as const,
};

const tileCellSx = { gridColumn: 2, gridRow: { xs: '1', md: '1 / span 3' }, display: 'flex' };

const lineSx = { gridColumn: { xs: '1 / -1', md: '1' }, margin: 0 };

const proofSx = {
  ...lineSx,
  marginTop: { xs: `${themeTokens.spacing[3]}px`, md: `${themeTokens.spacing[4]}px` },
  fontSize: { xs: themeTokens.typography.fontSize.base, md: themeTokens.typography.fontSize.lg },
  color: 'var(--neutral-800)',
  fontVariantNumeric: 'tabular-nums',
};

// --neutral-500, not 400: the separators are text on the page ground, and the
// public-page contrast audit (and public-reading-tokens.test.ts) hold every
// glyph here to 4.5:1. 400 measured 5.97:1 on #0E0E0E.
const proofSeparatorSx = { color: 'var(--neutral-500)' };

const starSx = { color: 'var(--color-amber)' };

// A 44px tap target, like the facts list's setter link, that still sits in the
// sentence at the line's own height: the negative block margins hand back
// everything above one line (`1lh`), so the proof line doesn't grow.
const setterLinkSx = {
  display: 'inline-flex',
  alignItems: 'center',
  minWidth: 44,
  minHeight: 44,
  marginBlock: 'calc((1lh - 44px) / 2)',
  maxWidth: '100%',
  fontWeight: themeTokens.typography.fontWeight.semibold,
  overflowWrap: 'anywhere' as const,
};

const contextSx = {
  ...lineSx,
  marginTop: `${themeTokens.spacing[1]}px`,
  fontSize: { xs: themeTokens.typography.fontSize.sm, md: themeTokens.typography.fontSize.base },
  color: 'var(--neutral-500)',
};

const SETTER_SLOT = 'setter';

/**
 * The climb page's heading block: the `<h1>`, the grade tile beside it, the
 * proof line ("4,171 sends · ★ 3.0 · set by BKBChicago") and the board and
 * angle under it.
 *
 * The `<h1>` is the climb name with the grade after it, visually hidden: the
 * coloured tile shows the grade and is `aria-hidden`, so a screen reader and a
 * crawler both read "Name, V5 (6c)" once. This is the page's ONLY `<h1>`; every
 * other front-door section heading is an `<h2>`. Element identity is pinned by
 * `view-seo-fragment.test.tsx`, which is why this stays one component.
 *
 * The star only shows when the angle's stats row carries a rating on the 1-5
 * scale — the same `normalizedQuality` rule the structured data uses — so an
 * Aurora 1-3 average is never printed as if it were out of five. Nothing in the
 * proof line is invented: a climb with no sends, no honest rating or no setter
 * simply drops that item.
 */
export default async function ClimbViewSeoFragment({
  climb,
  boardDetails,
  angle,
  currentAngleStats,
}: ClimbViewSeoFragmentProps) {
  const { t, locale } = await getServerTranslation('climbs');
  // An unnamed climb gets a translated "Unnamed Kilter climb" rather than
  // opening on a bare grade. URLs and the breadcrumb keep
  // `resolveClimbDisplayName`, which slugs need to stay stable.
  const climbName =
    climb.name?.trim() || t('frontDoor.hero.unnamedClimb', { board: formatBoardDisplayName(boardDetails.board_name) });
  const grade = climb.difficulty ? climbGradeForSearch(climb.difficulty) : '';
  const setter = climb.setter_username?.trim();
  // Typed as a number, but the row can carry Postgres's numeric string, and
  // i18next skips plural selection for a string count.
  const sends = Number(climb.ascensionist_count ?? 0);
  const quality = normalizedQuality(currentAngleStats);
  const boardLabel = climbBoardForSearch(boardDetails.board_name, boardDetails.layout_name);

  const proofItems: Array<{ key: string; content: React.ReactNode }> = [];
  if (Number.isFinite(sends) && sends > 0) {
    proofItems.push({
      key: 'sends',
      content: t('sends', { count: sends, formattedCount: new Intl.NumberFormat(locale).format(sends) }),
    });
  }
  if (quality) {
    const formattedQuality = formatQualityAverage(quality.average, locale);
    proofItems.push({
      key: 'quality',
      content: (
        <>
          <span aria-hidden="true">
            <Box component="span" sx={starSx}>
              ★
            </Box>{' '}
            {formattedQuality}
          </span>{' '}
          <Box component="span" sx={visuallyHidden}>
            {t('frontDoor.hero.qualityAria', { quality: formattedQuality })}
          </Box>
        </>
      ),
    });
  }
  if (setter) {
    proofItems.push({
      key: 'setter',
      content: fillNodeSlot(
        t('frontDoor.hero.setBy', { setter: nodeSlot(SETTER_SLOT) }),
        SETTER_SLOT,
        <MuiLink component={LocaleLink} href={`/setter/${encodeURIComponent(setter)}`} sx={setterLinkSx}>
          {setter}
        </MuiLink>,
      ),
    });
  }

  return (
    <Box component="header" sx={headerSx}>
      <Typography variant="h3" component="h1" sx={headingSx}>
        {climbName}
        {grade ? (
          <Box component="span" sx={visuallyHidden}>
            {t('frontDoor.hero.gradeForSearch', { grade })}
          </Box>
        ) : null}
      </Typography>
      <Box sx={tileCellSx}>
        <GradeTile difficulty={climb.difficulty} boardName={boardDetails.board_name} />
      </Box>
      {proofItems.length > 0 ? (
        <Typography component="p" sx={proofSx}>
          {proofItems.map(({ key, content }, index) => (
            <React.Fragment key={key}>
              {/* Spaces outside the hidden dot, so the text a crawler or a
                  screen reader gets still has word breaks between items. */}
              {index > 0 ? (
                <>
                  {' '}
                  <Box component="span" aria-hidden="true" sx={proofSeparatorSx}>
                    ·
                  </Box>{' '}
                </>
              ) : null}
              <span>{content}</span>
            </React.Fragment>
          ))}
        </Typography>
      ) : null}
      <Typography component="p" sx={contextSx}>
        {t('frontDoor.hero.boardAtAngle', { board: boardLabel, angle: angle ?? climb.angle })}
      </Typography>
    </Box>
  );
}
