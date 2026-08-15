'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import NearMeOutlined from '@mui/icons-material/NearMeOutlined';
import type { GymDirectoryCard as GymDirectoryCardData } from '@boardsesh/graphql/operations';
import { boardTypeLabel } from '@boardsesh/board-constants';
import type { GymClaimViewerState } from '@boardsesh/analytics';
import LocaleLink from '@/app/components/i18n/locale-link';
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
};

/**
 * One gym in the directory list.
 *
 * The card renders only schema-real fields: name, board chips, and a location
 * line WHEN THERE IS ONE. No photo, no description, no hours, no "verified"
 * treatment — the long tail of gyms will never have those, and a card design
 * that leans on them quietly demotes every gym nobody has filled in. Unclaimed
 * gyms render identically to claimed ones, with one extra quiet prompt and no
 * ranking or styling penalty.
 *
 * A CLIENT component, though it is still server-rendered into the first HTML
 * response like every other one: near-me results are fetched in the browser, so
 * one card has to render on both sides. The alternative was a second card
 * component for near-me that would drift from this one within a release.
 */
export default function GymDirectoryCard({ gym, origin, viewerState, locale }: GymDirectoryCardProps) {
  const { t } = useTranslation('gyms');
  // Shared across the 24 cards on the page rather than constructed per card.
  const formatNumber = numberFormatFor(locale);
  const chips = boardChips(gym.boardSummaries);
  const location = cardLocation(gym, origin);
  const distanceKm = distanceChipKm(gym, origin, location);

  return (
    <Box
      component="li"
      sx={{
        listStyle: 'none',
        border: '1px solid var(--neutral-200)',
        borderRadius: `${themeTokens.borderRadius.lg}px`,
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      <Typography variant="subtitle1" component="h3" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
        {/* A real anchor, server-rendered: this is how a crawler and a
            middle-click both reach the gym page. */}
        <MuiLink
          component={LocaleLink}
          href={`/gym/${gym.slug}`}
          underline="hover"
          sx={{ color: 'var(--color-primary)' }}
        >
          {gym.name}
        </MuiLink>
      </Typography>

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
              sx={{ borderRadius: `${themeTokens.borderRadius.full}px` }}
            />
          ))}
        </Box>
      )}

      {!gym.isClaimed && (
        <GymDirectoryClaimLink gymUuid={gym.uuid} gymSlug={gym.slug ?? ''} viewerState={viewerState} />
      )}
    </Box>
  );
}
