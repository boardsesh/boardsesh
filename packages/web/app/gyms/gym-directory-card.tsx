'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import NearMeOutlined from '@mui/icons-material/NearMeOutlined';
import CheckCircleOutline from '@mui/icons-material/CheckCircleOutline';
import type { GymDirectoryCard as GymDirectoryCardData } from '@boardsesh/graphql/operations';
import { boardTypeLabel } from '@boardsesh/board-constants';
import type { GymClaimViewerState } from '@boardsesh/analytics';
import type { BoardDiscoveryBoard } from '@boardsesh/shared-schema';
import GymBoardPreviews from '@/app/components/board-entity/gym-board-previews';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageCard } from '@/app/components/ui/page-shell';
import type { Locale } from '@/app/lib/i18n/config';
import { themeTokens } from '@/app/theme/theme-config';
import { boardChips, cardLocation, distanceChipKm, numberFormatFor, roundDistanceKm } from './directory-card-model';
import GymDirectoryClaimLink from './gym-directory-claim-link';

type GymDirectoryCardProps = {
  gym: GymDirectoryCardData;
  /**
   * Proximity origin: `?lat`/`?lng` on a server-rendered page, or the near-me
   * origin the visitor shared with the client. Null when there is neither.
   */
  origin: { latitude: number; longitude: number } | null;
  viewerState: GymClaimViewerState;
  /** Formats the distance for the active locale. */
  locale: Locale;
  /** Public physical installations, fetched only for the homepage teaser. */
  boardPreviews?: BoardDiscoveryBoard[];
};

/**
 * One gym in the directory list.
 *
 * The card renders only schema-real fields: name, board chips, and a location
 * line WHEN THERE IS ONE. No photo, no description, no hours, no "verified"
 * treatment. Claim badges report who maintains a listing; sparse and unclaimed
 * listings retain the same card surface and their claim prompt.
 *
 * A CLIENT component, though it is still server-rendered into the first HTML
 * response like every other one: near-me results are fetched in the browser, so
 * one card has to render on both sides. The alternative was a second card
 * component for near-me that would drift from this one within a release.
 */
export default function GymDirectoryCard({ gym, origin, viewerState, locale, boardPreviews }: GymDirectoryCardProps) {
  const { t } = useTranslation('gyms');
  // Shared across the 24 cards on the page rather than constructed per card.
  const formatNumber = numberFormatFor(locale);
  const location = cardLocation(gym, origin);
  const distanceKm = distanceChipKm(gym, origin, location);
  const visibleBoardPreviews = boardPreviews?.filter((board) => board.gymUuid === gym.uuid).slice(0, 3);
  const chips = boardChips(gym.boardSummaries).filter(
    (chip) =>
      !visibleBoardPreviews?.some(
        (board) => board.boardType === chip.boardType && Math.round(board.angle) === chip.angle,
      ),
  );

  return (
    /* A FILL, not a hairline. The card used to be `1px solid var(--neutral-200)`
       over nothing, which on the near-black ground left 24 near-invisible
       outlines where a grid should be. `PageCard` gives it the surface violet
       the rest of the site uses, and hover raises it one step so the whole card
       reads as the target it is. */
    <PageCard
      component="li"
      variant="surface"
      padding="sm"
      sx={{
        listStyle: 'none',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        transition: 'background-color 120ms ease, border-color 120ms ease',
        '&:hover': {
          backgroundColor: 'var(--semantic-surface-elevated)',
          borderColor: 'var(--color-primary)',
        },
      }}
    >
      <Typography
        variant="subtitle1"
        component="h3"
        sx={{
          fontSize: themeTokens.typography.fontSize.xl,
          lineHeight: 1.3,
          fontWeight: themeTokens.typography.fontWeight.semibold,
        }}
      >
        {/* A real anchor, server-rendered: this is how a crawler and a
            middle-click both reach the gym page. */}
        <MuiLink
          component={LocaleLink}
          href={`/gym/${gym.slug}`}
          underline="hover"
          sx={{ color: 'text.primary', '&:hover': { color: 'var(--color-primary)' } }}
        >
          {gym.name}
        </MuiLink>
      </Typography>

      <Chip
        size="small"
        icon={gym.isClaimed ? <CheckCircleOutline /> : undefined}
        label={gym.isClaimed ? t('card.claimed') : t('card.unclaimed')}
        sx={{
          alignSelf: 'flex-start',
          backgroundColor: gym.isClaimed ? 'var(--color-success-bg)' : 'transparent',
          color: gym.isClaimed ? 'var(--color-success)' : 'var(--neutral-500)',
          border: '1px solid var(--separator)',
          '& .MuiChip-icon': { color: 'inherit' },
        }}
      />

      {location && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <LocationOnOutlined sx={{ fontSize: themeTokens.typography.fontSize.base, color: 'var(--neutral-500)' }} />
          <Typography variant="body2" color="text.secondary">
            {location.kind === 'address'
              ? location.address
              : t('card.distance', { distance: formatNumber.format(roundDistanceKm(location.km)) })}
          </Typography>
        </Box>
      )}

      {/* Only when the address already took the location line: a gym with a pin
          and no address shows its distance there, and repeating it here would
          be the same fact twice. */}
      {distanceKm !== null && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <NearMeOutlined sx={{ fontSize: themeTokens.typography.fontSize.base, color: 'var(--neutral-500)' }} />
          <Typography variant="body2" color="text.secondary">
            {t('card.distance', { distance: formatNumber.format(roundDistanceKm(distanceKm)) })}
          </Typography>
        </Box>
      )}

      {chips.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
          {chips.map((chip) => (
            <Chip
              key={chip.key}
              size="small"
              // Brand names are proper nouns and stay untranslated; only the
              // "<board> <angle>°" arrangement goes through the catalog.
              label={
                chip.angle > 0
                  ? t('card.boardChip', { board: boardTypeLabel(chip.boardType), angle: chip.angle })
                  : boardTypeLabel(chip.boardType)
              }
              // The elevated surface, so the chips stay separable from the card
              // they sit on at rest AND on hover, which raises the card to the
              // same step.
              sx={{
                borderRadius: 'var(--border-radius-full)',
                backgroundColor: 'var(--semantic-selected)',
                border: '1px solid var(--separator)',
                color: 'var(--neutral-900)',
                fontWeight: themeTokens.typography.fontWeight.semibold,
              }}
            />
          ))}
        </Box>
      )}

      {visibleBoardPreviews && visibleBoardPreviews.length > 0 && <GymBoardPreviews boards={visibleBoardPreviews} />}

      {!gym.isClaimed && (
        <GymDirectoryClaimLink gymUuid={gym.uuid} gymSlug={gym.slug ?? ''} viewerState={viewerState} />
      )}
    </PageCard>
  );
}
