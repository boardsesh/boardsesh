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
import LocaleLink from '@/app/components/i18n/locale-link';
import type { Locale } from '@/app/lib/i18n/config';
import { themeTokens } from '@/app/theme/theme-config';
import { boardChips, cardLocation, distanceChipKm, numberFormatFor, roundDistanceKm } from './directory-card-model';
import GymDirectoryClaimLink from './gym-directory-claim-link';
import styles from './gym-directory-card.module.css';

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
 * treatment. Claim badges report who maintains a listing; sparse and unclaimed
 * listings retain the same divided row and their claim prompt.
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
  const location = cardLocation(gym, origin);
  const distanceKm = distanceChipKm(gym, origin, location);
  const chips = boardChips(gym.boardSummaries);

  return (
    <Box component="li" className={styles.row}>
      <Box className={styles.heading}>
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
      </Box>

      {location && (
        <Box className={styles.location}>
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
        <Box className={styles.location}>
          <NearMeOutlined sx={{ fontSize: themeTokens.typography.fontSize.base, color: 'var(--neutral-500)' }} />
          <Typography variant="body2" color="text.secondary">
            {t('card.distance', { distance: formatNumber.format(roundDistanceKm(distanceKm)) })}
          </Typography>
        </Box>
      )}

      <Box className={styles.details}>
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
                // A quiet filled chip remains legible on the page or the
                // homepage locator's shared surface.
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

        {!gym.isClaimed && (
          <GymDirectoryClaimLink gymUuid={gym.uuid} gymSlug={gym.slug ?? ''} viewerState={viewerState} />
        )}
      </Box>
    </Box>
  );
}
