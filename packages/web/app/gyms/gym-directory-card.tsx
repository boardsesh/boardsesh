import React from 'react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import type { GymDirectoryCard as GymDirectoryCardData } from '@boardsesh/graphql/operations';
import { boardTypeLabel } from '@boardsesh/board-constants';
import type { GymClaimViewerState } from '@boardsesh/analytics';
import LocaleLink from '@/app/components/i18n/locale-link';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';
import { boardChips, cardLocation, roundDistanceKm } from './directory-card-model';
import GymDirectoryClaimLink from './gym-directory-claim-link';

type GymDirectoryCardProps = {
  gym: GymDirectoryCardData;
  /** Proximity origin from `?lat`/`?lng`, or null when the request had none. */
  origin: { latitude: number; longitude: number } | null;
  viewerState: GymClaimViewerState;
  /** Formats a number for the active locale. */
  formatNumber: (value: number) => string;
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
 */
export default async function GymDirectoryCard({ gym, origin, viewerState, formatNumber }: GymDirectoryCardProps) {
  const { t } = await getServerTranslation('gyms');
  const chips = boardChips(gym.boardSummaries);
  const location = cardLocation(gym, origin);

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
              : t('card.distance', { distance: formatNumber(roundDistanceKm(location.km)) })}
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
