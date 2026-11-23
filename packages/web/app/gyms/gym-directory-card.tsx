'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import LocationOnOutlined from '@mui/icons-material/LocationOnOutlined';
import NearMeOutlined from '@mui/icons-material/NearMeOutlined';
import CheckCircleOutline from '@mui/icons-material/CheckCircleOutline';
import VerifiedUserOutlined from '@mui/icons-material/VerifiedUserOutlined';
import { gymClaimCtaClicked, type GymClaimViewerState } from '@boardsesh/analytics';
import type { GymDirectoryCard as GymDirectoryCardData } from '@boardsesh/graphql/operations';
import { boardTypeLabel } from '@boardsesh/board-constants';
import LocaleLink from '@/app/components/i18n/locale-link';
import type { Locale } from '@/app/lib/i18n/config';
import { trackGymFunnelEvent } from '@/app/lib/gym-funnel-analytics';
import { themeTokens } from '@/app/theme/theme-config';
import {
  boardChips,
  cardClaimHref,
  cardListingState,
  cardLocation,
  distanceChipKm,
  numberFormatFor,
  roundDistanceKm,
} from './directory-card-model';
import styles from './gym-directory-card.module.css';

type GymDirectoryCardProps = {
  gym: GymDirectoryCardData;
  /**
   * Proximity origin: `?lat`/`?lng` on a server-rendered page, or the near-me
   * origin the visitor shared with the client. Null when there is neither.
   */
  origin: { latitude: number; longitude: number } | null;
  /** Formats the distance for the active locale. */
  locale: Locale;
  /**
   * Claim mode (`/gyms?claim=1`): who is looking, settled on the server from
   * the session. A card on a gym nobody runs yet then carries Claim this gym.
   */
  claim?: { viewerState: GymClaimViewerState };
};

/**
 * One gym in the directory list.
 *
 * The card renders only schema-real fields: name, board chips, and a location
 * line WHEN THERE IS ONE. No photo, no description, no hours, no "verified"
 * treatment. The listing chip reports who runs a listing; sparse and unclaimed
 * listings retain the same divided row.
 *
 * No claim prompt on the row in ordinary browsing. It was repeated on every
 * unclaimed gym, which is most of them, so the directory carries ONE prompt
 * under the list (`gym-directory-claim-link.tsx`). That prompt, and the for-gyms
 * and footer links, open claim mode (`?claim=1`), where a gym nobody runs yet
 * carries its own Claim this gym button: by then the visitor has said they are
 * looking for their gym.
 *
 * A CLIENT component, though it is still server-rendered into the first HTML
 * response like every other one: near-me results are fetched in the browser, so
 * one card has to render on both sides. The alternative was a second card
 * component for near-me that would drift from this one within a release.
 */
export default function GymDirectoryCard({ gym, origin, locale, claim }: GymDirectoryCardProps) {
  const { t } = useTranslation('gyms');
  // Shared across the 24 cards on the page rather than constructed per card.
  const formatNumber = numberFormatFor(locale);
  const location = cardLocation(gym, origin);
  const distanceKm = distanceChipKm(gym, origin, location);
  const chips = boardChips(gym.boardSummaries);
  const listingState = cardListingState(gym);
  const isRunByGym = listingState === 'RUN_BY_GYM';
  const listingLabel = isRunByGym
    ? t('card.claimed')
    : listingState === 'CLIMBER_LISTED'
      ? t('card.climberListed')
      : t('card.unclaimed');
  // A gym its staff run is never offered: a dispute is a report from its page.
  const claimHref = claim && !isRunByGym && gym.slug ? cardClaimHref(gym.slug, claim.viewerState, locale) : null;

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

        {/* Who runs the listing, in the three states the gym page uses.
            "Run by the gym" earns the filled chip: it reports a state somebody
            acted to reach. The other two are the absence of that, and a
            bordered pill around them would draw a control nobody can press, so
            they keep the label and drop the box. */}
        <Chip
          size="small"
          icon={isRunByGym ? <CheckCircleOutline /> : undefined}
          label={listingLabel}
          sx={{
            alignSelf: 'flex-start',
            backgroundColor: isRunByGym ? 'var(--color-success-bg)' : 'transparent',
            color: isRunByGym ? 'var(--color-success)' : 'var(--neutral-500)',
            border: isRunByGym ? '1px solid var(--separator)' : 'none',
            '& .MuiChip-icon': { color: 'inherit' },
            '& .MuiChip-label': isRunByGym ? {} : { px: 0 },
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
                  backgroundColor: 'var(--semantic-fill)',
                  border: '1px solid var(--separator)',
                  color: 'var(--neutral-900)',
                  fontWeight: themeTokens.typography.fontWeight.semibold,
                }}
              />
            ))}
          </Box>
        )}
        {/* Claim mode only: the person came to find their own gym, so the
            card they find it on goes straight to the claim (sign-in first
            when signed out), not to a page with a second button. */}
        {claimHref && claim && (
          <Button
            component={LocaleLink}
            href={claimHref}
            variant="outlined"
            size="small"
            startIcon={<VerifiedUserOutlined />}
            aria-label={t('card.claimCtaAria', { gym: gym.name })}
            onClick={() =>
              trackGymFunnelEvent(
                gymClaimCtaClicked({
                  placement: 'directory-result',
                  viewerState: claim.viewerState,
                  gymUuid: gym.uuid,
                }),
              )
            }
            sx={{ textTransform: 'none', minHeight: 44 }}
          >
            {t('card.claimCta')}
          </Button>
        )}
      </Box>
    </Box>
  );
}
