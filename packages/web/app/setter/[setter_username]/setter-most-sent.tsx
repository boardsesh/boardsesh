import React from 'react';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { BOARD_FIELD_COLORS } from '@boardsesh/board-look';
import GradeChip from '@/app/components/climb-card/grade-chip';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageSection } from '@/app/components/ui/page-shell';
import boardArtStyles from '@/app/components/board-renderer/board-art-theme.module.css';
import { buildBoardArtLayers, toDarkArtUrl } from '@/app/components/board-renderer/util';
import { formatVGrade } from '@/app/lib/grade-colors';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { resolveClimbDisplayName } from '@/app/lib/string-utils';
import { buildCanonicalClimbViewUrl } from '@/app/lib/url-utils';
import { themeTokens } from '@/app/theme/theme-config';
import type { MostSentPick } from './setter-most-sent-picks';

type SetterMostSentProps = {
  picks: readonly MostSentPick[];
};

// Three across from md up. Below it, one swipeable row that bleeds to the
// screen edge, so the next card peeks in and says there is more.
const cardsSx = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: { xs: 'flex', md: 'grid' },
  gridTemplateColumns: { md: 'repeat(3, minmax(0, 1fr))' },
  gap: { xs: `${themeTokens.spacing[3]}px`, md: `${themeTokens.spacing[5]}px` },
  overflowX: { xs: 'auto', md: 'visible' },
  scrollSnapType: { xs: 'x mandatory', md: 'none' },
  marginInline: { xs: 'calc(-1 * var(--page-gutter))', md: 0 },
  paddingInline: { xs: 'var(--page-gutter)', md: 0 },
  scrollPaddingInline: 'var(--page-gutter)',
  scrollbarWidth: 'none',
} as const;

const cardSx = {
  position: 'relative',
  flex: { xs: '0 0 250px', md: 'initial' },
  minWidth: 0,
  scrollSnapAlign: 'start',
  // The art box is the card's first child.
  '&:hover > :first-of-type': { borderColor: 'var(--control-border)' },
} as const;

// The art box is the board's own field colour, so the render's edges disappear
// into it. A fixed aspect ratio keeps three boards of different shapes the same
// height, and reserves the box before the lazy images arrive.
const artSx = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gridTemplateRows: 'minmax(0, 1fr)',
  aspectRatio: '4 / 4.4',
  padding: `${themeTokens.spacing[4]}px`,
  borderRadius: `${themeTokens.borderRadius.xl}px`,
  border: '1px solid var(--border-subtle)',
  backgroundColor: BOARD_FIELD_COLORS.dark,
  overflow: 'hidden',
  // `display` is left to the dark-art classes on a themed board's paired layers.
  //
  // A render that fails (a cold renderer queue can refuse one) must leave an
  // empty board frame, not the browser's broken-image icon and painted alt
  // text. Transparent text hides the alt; the `::after` covers the icon. A
  // loaded image is a replaced element and never draws `::after`, so it only
  // exists on a failed one. The alt stays in the markup for screen readers.
  '& > img': {
    gridArea: '1 / 1',
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    minWidth: 0,
    minHeight: 0,
    position: 'relative',
    color: 'transparent',
    '&::after': {
      content: '""',
      position: 'absolute',
      inset: 0,
      backgroundColor: BOARD_FIELD_COLORS.dark,
    },
  },
} as const;

const metaSx = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  alignItems: 'center',
  columnGap: `${themeTokens.spacing[3]}px`,
  rowGap: `${themeTokens.spacing[1]}px`,
  marginTop: `${themeTokens.spacing[3]}px`,
} as const;

// The name row is the card's anchor, and the anchor's own box is a full 44px
// target. The ellipsis sits on the name inside it, so a long name shortens
// without the anchor (or its focus ring) being clipped.
const nameRowSx = {
  display: 'flex',
  alignItems: 'center',
  minWidth: 0,
  minHeight: 44,
  color: 'var(--neutral-900)',
  fontSize: { xs: themeTokens.typography.fontSize.base, md: themeTokens.typography.fontSize.lg },
  fontWeight: themeTokens.typography.fontWeight.semibold,
} as const;

const nameTextSx = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

const rankSx = {
  marginRight: `${themeTokens.spacing[2]}px`,
  color: 'var(--neutral-500)',
  fontWeight: themeTokens.typography.fontWeight.medium,
  fontVariantNumeric: 'tabular-nums',
} as const;

// The whole card is the target, through the name's anchor: one link per card,
// and the anchor text is the climb's name rather than an image.
const nameLinkSx = {
  ...nameRowSx,
  '&::after': {
    content: '""',
    position: 'absolute',
    inset: 0,
    borderRadius: `${themeTokens.borderRadius.xl}px`,
  },
  '&:focus-visible': { outline: 'none' },
  '&:focus-visible::after': { outline: '2px solid var(--color-primary)', outlineOffset: 2 },
} as const;

const subSx = {
  gridColumn: '1 / -1',
  margin: 0,
  color: 'var(--neutral-500)',
  fontSize: themeTokens.typography.fontSize.sm,
  fontVariantNumeric: 'tabular-nums',
} as const;

/**
 * The setter's three most-sent climbs as large board art, above the full list.
 *
 * A server component with plain `<img>`s, like the climb page's board art:
 * `BoardImageLayers` reports a failed overlay from an `onError` handler, which a
 * server component cannot pass. The URLs come from the same
 * `buildBoardArtLayers` it uses, at full size and on the canonical config, so a
 * card's art is the image the climb's own page shows and is usually already in
 * the CDN. The first card is in the first screen at 390px and at 1440px, so it
 * loads eagerly at high priority (the list below gives up its own first-row
 * priority for it); the other two are lazy.
 *
 * The cards repeat climbs the list below also links, at the same URL.
 */
export default async function SetterMostSent({ picks }: SetterMostSentProps) {
  if (picks.length === 0) return null;
  const { t, locale } = await getServerTranslation('profile');
  const numberFormat = new Intl.NumberFormat(locale);

  return (
    <PageSection title={t('setter.mostSent.heading')}>
      <Box component="ol" sx={cardsSx}>
        {picks.map(({ climb, boardDetails, linked }, index) => {
          const isFirst = index === 0;
          const loading = isFirst ? undefined : 'lazy';
          const fetchPriority = isFirst ? 'high' : undefined;
          const boardLabel = boardTypeLabel(boardDetails.board_name);
          const displayName = climb.name || resolveClimbDisplayName(null, boardLabel);
          // The slug name exactly as `StaticClimbRow` builds it, so the card and
          // the row below it name one URL.
          const href = linked
            ? buildCanonicalClimbViewUrl(
                boardDetails,
                climb.angle,
                climb.uuid,
                resolveClimbDisplayName(climb.name, boardDetails.board_name),
              )
            : null;
          const { backgroundUrls, overlayUrl } = buildBoardArtLayers(boardDetails, climb.frames);
          const grade = formatVGrade(climb.difficulty, boardDetails.board_name);
          const rankAndName = (
            <>
              <Box component="span" aria-hidden="true" sx={rankSx}>
                {index + 1}
              </Box>
              <Box component="span" sx={nameTextSx}>
                {displayName}
              </Box>
            </>
          );

          return (
            <Box component="li" key={climb.uuid} sx={cardSx}>
              <Box sx={artSx}>
                {backgroundUrls.map((backgroundUrl) => (
                  <React.Fragment key={backgroundUrl}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- static board photo, same as the climb page */}
                    <img
                      src={backgroundUrl}
                      alt=""
                      width={boardDetails.boardWidth}
                      height={boardDetails.boardHeight}
                      className={boardArtStyles.lightArt}
                      loading={loading}
                      fetchPriority={fetchPriority}
                      decoding="async"
                    />
                    {/* eslint-disable-next-line @next/next/no-img-element -- static board photo, same as the climb page */}
                    <img
                      src={toDarkArtUrl(backgroundUrl)}
                      alt=""
                      width={boardDetails.boardWidth}
                      height={boardDetails.boardHeight}
                      className={boardArtStyles.darkArt}
                      loading={loading}
                      fetchPriority={fetchPriority}
                      decoding="async"
                    />
                  </React.Fragment>
                ))}
                {overlayUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- the render route is already an optimised image endpoint
                  <img
                    src={overlayUrl}
                    alt={t('setter.mostSent.artAlt', {
                      climbName: displayName,
                      board: boardDetails.layout_name || boardLabel,
                      angle: climb.angle,
                    })}
                    width={boardDetails.boardWidth}
                    height={boardDetails.boardHeight}
                    loading={loading}
                    fetchPriority={fetchPriority}
                    decoding="async"
                  />
                ) : null}
              </Box>
              <Box sx={metaSx}>
                {href ? (
                  <MuiLink
                    component={LocaleLink}
                    href={href}
                    prefetch={false}
                    underline="none"
                    color="inherit"
                    sx={nameLinkSx}
                  >
                    {rankAndName}
                  </MuiLink>
                ) : (
                  <Box sx={nameRowSx}>{rankAndName}</Box>
                )}
                {grade ? <GradeChip label={grade} /> : null}
                <Typography component="p" sx={subSx}>
                  {t('setter.mostSent.meta', {
                    count: climb.ascensionist_count,
                    sends: numberFormat.format(climb.ascensionist_count),
                    angle: climb.angle,
                  })}
                </Typography>
              </Box>
            </Box>
          );
        })}
      </Box>
    </PageSection>
  );
}
