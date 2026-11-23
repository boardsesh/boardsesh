import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableFooter from '@mui/material/TableFooter';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import { visuallyHidden } from '@mui/utils';
import LocaleLink from '@/app/components/i18n/locale-link';
import { formatFontGrade, formatVGrade } from '@/app/lib/grade-colors';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { climbGradeForSearch } from '@/app/lib/seo/climb-display';
import { themeTokens } from '@/app/theme/theme-config';
import { buildCanonicalClimbViewUrl, constructBoardSlugViewUrl } from '@/app/lib/url-utils';
import type { ClimbStatsForAngle } from '@/app/lib/data/queries';
import type { BoardRouteIdentity } from '@/app/lib/types';
import { formatQualityAverage, sendCount } from './climb-facts-format';
import { frontDoorSectionHeadingSx } from './front-door-heading-sx';
import GradeTile from './grade-tile';
import { normalizedQuality } from '@/app/lib/climb-quality';

type AngleTableProps = {
  boardDetails: BoardRouteIdentity;
  /** Set on `/b/{slug}`: angle links stay on the reader's named board. */
  boardSlug?: string;
  climbUuid: string;
  climbName: string;
  currentAngle: number;
  angleStats: ClimbStatsForAngle[];
};

/** MUI's md breakpoint, as the page's CSS module writes it. */
const BELOW_MD = '@media (max-width: 899.98px)';

// The card scrolls sideways inside itself if a locale's headers ever outgrow a
// 390px phone, so the page never does.
const tableCardSx = {
  overflowX: 'auto' as const,
  bgcolor: 'var(--semantic-surface)',
  border: '1px solid var(--separator)',
  borderRadius: `${themeTokens.borderRadius.xl}px`,
};

const tableSx = {
  fontVariantNumeric: 'tabular-nums',
  fontSize: themeTokens.typography.fontSize.sm,
};

const cellInlinePadding = { xs: `${themeTokens.spacing[3]}px`, md: `${themeTokens.spacing[4]}px` };

// MUI's TableCell brings its own type scale, 16px padding and bottom rule; the
// rows here take the table's type and draw one hairline above each row.
const tableCellResetSx = {
  borderBottom: 'none',
  fontFamily: 'inherit',
  fontSize: 'inherit',
  lineHeight: 'inherit',
  letterSpacing: 'inherit',
};

// --neutral-500 for every muted glyph here: the public-page audit holds all
// text to 4.5:1, and it measures 6.08:1 on the current row's raised surface.
const headerCellSx = {
  ...tableCellResetSx,
  paddingBlock: `${themeTokens.spacing[3]}px`,
  paddingInline: cellInlinePadding,
  textAlign: 'left' as const,
  fontSize: themeTokens.typography.fontSize.xs,
  fontWeight: themeTokens.typography.fontWeight.medium,
  color: 'var(--neutral-500)',
  whiteSpace: 'nowrap' as const,
};

const cellSx = {
  ...tableCellResetSx,
  height: { xs: 44, md: 46 },
  paddingBlock: 0,
  paddingInline: cellInlinePadding,
  borderTop: '1px solid var(--separator)',
  color: 'var(--neutral-700)',
  whiteSpace: 'nowrap' as const,
};

const numberCellSx = { ...cellSx, textAlign: 'right' as const };

// "Not rated" may wrap in a long locale rather than widen the table.
const qualityCellSx = { ...numberCellSx, whiteSpace: 'normal' as const };

const rightHeaderCellSx = { ...headerCellSx, textAlign: 'right' as const };

// The angle cell has no padding of its own: the link fills it, so the whole
// cell is the tap target (44px tall on a phone, 46px from md).
const angleCellSx = {
  ...cellSx,
  paddingInline: 0,
  textAlign: 'left' as const,
  fontWeight: themeTokens.typography.fontWeight.semibold,
};

const currentAngleCellSx = {
  ...angleCellSx,
  paddingInline: cellInlinePadding,
  color: 'var(--neutral-900)',
  fontWeight: themeTokens.typography.fontWeight.bold,
  boxShadow: 'inset 3px 0 0 var(--color-primary)',
};

const currentRowSx = {
  bgcolor: 'var(--semantic-surface-elevated)',
  '& td': { color: 'var(--neutral-900)' },
};

// The table card clips its overflow, so the focus ring is drawn inside the link.
const angleLinkSx = {
  display: 'flex',
  alignItems: 'center',
  minWidth: 44,
  minHeight: { xs: 44, md: 46 },
  paddingInline: cellInlinePadding,
  fontWeight: themeTokens.typography.fontWeight.semibold,
  '&:focus-visible': { outlineOffset: '-3px' },
};

// Named on the current row only from md; a phone keeps the raised row and the
// violet edge, and a screen reader still hears it.
const thisPageSx = {
  marginLeft: `${themeTokens.spacing[2]}px`,
  fontSize: themeTokens.typography.fontSize.xs,
  fontWeight: themeTokens.typography.fontWeight.medium,
  color: 'var(--neutral-500)',
  [BELOW_MD]: visuallyHidden,
};

const fontGradeSx = {
  marginLeft: `${themeTokens.spacing[2]}px`,
  color: 'var(--neutral-500)',
  [BELOW_MD]: { display: 'none' },
};

const gradeCellContentSx = { display: 'inline-flex', alignItems: 'center' };

const mutedSx = { color: 'var(--neutral-500)' };

const starSx = { color: 'var(--color-amber)' };

const totalCellSx = {
  ...cellSx,
  color: 'var(--neutral-500)',
  whiteSpace: 'normal' as const,
};

function GradeCellContent({
  difficulty,
  boardName,
  unknownLabel,
}: {
  difficulty: string | null;
  boardName: string;
  unknownLabel: string;
}) {
  if (!difficulty) {
    return (
      <Box component="span" sx={mutedSx}>
        {unknownLabel}
      </Box>
    );
  }
  if (!formatVGrade(difficulty, boardName)) return <>{climbGradeForSearch(difficulty)}</>;
  const fontGrade = formatFontGrade(difficulty);
  // The chip and the Font grade are pictures of the grade; the hidden text is
  // the grade in words, once, for a screen reader.
  return (
    <Box component="span" sx={gradeCellContentSx}>
      <GradeTile difficulty={difficulty} boardName={boardName} size="compact" />
      {fontGrade ? (
        <Box component="span" aria-hidden="true" sx={fontGradeSx}>
          {fontGrade}
        </Box>
      ) : null}
      <Box component="span" sx={visuallyHidden}>
        {climbGradeForSearch(difficulty)}
      </Box>
    </Box>
  );
}

/**
 * "Grades at every angle": one row per angle the climb has stats for, with its
 * grade, sends and quality, from the `angleStats` the page already loaded.
 *
 * The angle dimension is the front door's worst duplicate-content problem — one
 * climb, N near-identical pages — and this table turns it into an internal-link
 * mesh: every other angle is a real `<a href>` a crawler follows. Every row is
 * rendered; a board tops out around 15 angles, and nothing a crawler should
 * follow sits behind a disclosure. The angle being viewed is text, marked
 * `aria-current`, never a self-link.
 */
export default async function AngleTable({
  boardDetails,
  boardSlug,
  climbUuid,
  climbName,
  currentAngle,
  angleStats,
}: AngleTableProps) {
  const { t, locale } = await getServerTranslation('climbs');
  if (angleStats.length === 0) return null;

  const sortedStats = [...angleStats].sort((left, right) => left.angle - right.angle);
  const numberFormat = new Intl.NumberFormat(locale);
  const totalSends = sortedStats.reduce((total, stats) => total + sendCount(stats.ascensionist_count), 0);
  const angleHref = (angle: number) =>
    boardSlug
      ? constructBoardSlugViewUrl(encodeURIComponent(boardSlug), angle, climbUuid, climbName)
      : buildCanonicalClimbViewUrl(boardDetails, angle, climbUuid, climbName);

  return (
    <Box component="section" aria-labelledby="angle-table-heading">
      <Typography variant="h5" component="h2" id="angle-table-heading" sx={frontDoorSectionHeadingSx}>
        {t('frontDoor.angles.heading')}
      </Typography>
      <Box sx={tableCardSx}>
        <Table aria-labelledby="angle-table-heading" sx={tableSx}>
          <TableHead>
            <TableRow>
              <TableCell component="th" scope="col" sx={headerCellSx}>
                {t('frontDoor.angles.colAngle')}
              </TableCell>
              <TableCell component="th" scope="col" sx={headerCellSx}>
                {t('frontDoor.angles.colGrade')}
              </TableCell>
              <TableCell component="th" scope="col" sx={rightHeaderCellSx}>
                {t('frontDoor.angles.colSends')}
              </TableCell>
              <TableCell component="th" scope="col" sx={rightHeaderCellSx}>
                {t('frontDoor.angles.colQuality')}
              </TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sortedStats.map((stats) => {
              const isCurrent = stats.angle === currentAngle;
              const quality = normalizedQuality(stats);
              const formattedQuality = quality ? formatQualityAverage(quality.average, locale) : null;
              return (
                <TableRow
                  key={stats.angle}
                  aria-current={isCurrent ? 'page' : undefined}
                  sx={isCurrent ? currentRowSx : undefined}
                >
                  <TableCell component="th" scope="row" sx={isCurrent ? currentAngleCellSx : angleCellSx}>
                    {isCurrent ? (
                      <>
                        {t('frontDoor.facts.angleValue', { angle: stats.angle })}
                        <Box component="span" sx={thisPageSx}>
                          {t('frontDoor.angles.thisPage')}
                        </Box>
                      </>
                    ) : (
                      <MuiLink component={LocaleLink} href={angleHref(stats.angle)} underline="hover" sx={angleLinkSx}>
                        {/* "25°" on screen; the link's name, for a screen reader and
                          as anchor text, is "Climb name at 25°". */}
                        <Box component="span" aria-hidden="true">
                          {t('frontDoor.facts.angleValue', { angle: stats.angle })}
                        </Box>
                        <Box component="span" sx={visuallyHidden}>
                          {t('frontDoor.angles.linkName', { climbName, angle: stats.angle })}
                        </Box>
                      </MuiLink>
                    )}
                  </TableCell>
                  <TableCell sx={cellSx}>
                    <GradeCellContent
                      difficulty={stats.difficulty}
                      boardName={boardDetails.board_name}
                      unknownLabel={t('frontDoor.facts.unknown')}
                    />
                  </TableCell>
                  <TableCell sx={numberCellSx}>{numberFormat.format(sendCount(stats.ascensionist_count))}</TableCell>
                  <TableCell sx={qualityCellSx}>
                    {formattedQuality ? (
                      <>
                        <Box component="span" aria-hidden="true">
                          <Box component="span" sx={starSx}>
                            ★
                          </Box>{' '}
                          {formattedQuality}
                        </Box>
                        <Box component="span" sx={visuallyHidden}>
                          {t('frontDoor.hero.qualityAria', { quality: formattedQuality })}
                        </Box>
                      </>
                    ) : (
                      <Box component="span" sx={mutedSx}>
                        {t('frontDoor.angles.notRated')}
                      </Box>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          {/* A one-row table would only repeat its row, and nothing logged is no total. */}
          {sortedStats.length > 1 && totalSends > 0 ? (
            <TableFooter>
              <TableRow>
                <TableCell colSpan={4} sx={totalCellSx}>
                  {t('frontDoor.angles.total', {
                    count: totalSends,
                    formattedCount: numberFormat.format(totalSends),
                    angleCount: sortedStats.length,
                  })}
                </TableCell>
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </Box>
    </Box>
  );
}
