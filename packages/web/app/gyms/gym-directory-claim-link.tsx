'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import MuiLink from '@mui/material/Link';
import { gymClaimCtaClicked, type GymClaimViewerState } from '@boardsesh/analytics';
import LocaleLink from '@/app/components/i18n/locale-link';
import { trackGymFunnelEvent } from '@/app/lib/gym-funnel-analytics';
import { themeTokens } from '@/app/theme/theme-config';

type GymDirectoryClaimLinkProps = {
  gymUuid: string;
  gymSlug: string;
  /**
   * Settled on the SERVER from the request's auth cookie, never with
   * `useSession()` — next-auth starts every page load at `loading`, and a click
   * that beats the round-trip would report a signed-in climber as signed-out.
   */
  viewerState: GymClaimViewerState;
};

/**
 * The quiet claim prompt on an unclaimed directory card.
 *
 * A LINK to the gym page, not a dialog: the directory's audience is anonymous
 * (that is the point of an indexable page), the claim flow needs an account,
 * and a modal that opens straight into an auth wall is a worse first move than
 * landing on the gym itself. It also keeps the card crawlable — one more real
 * `<a href>` to `/gym/[slug]`.
 *
 * Rendered off `gym.isClaimed`, never `canClaim`: `canClaim` is viewer-scoped
 * and false for every signed-out visitor, so gating on it would hide the prompt
 * from everyone the directory exists for.
 */
export default function GymDirectoryClaimLink({ gymUuid, gymSlug, viewerState }: GymDirectoryClaimLinkProps) {
  const { t } = useTranslation('gyms');

  return (
    <MuiLink
      component={LocaleLink}
      href={`/gym/${gymSlug}`}
      underline="hover"
      onClick={() => {
        trackGymFunnelEvent(gymClaimCtaClicked({ placement: 'directory-card', viewerState, gymUuid }));
      }}
      sx={{
        // CSS var, not a direct themeTokens read: a token read at module scope
        // is scheme-static and would stay light-mode grey in dark mode.
        color: 'var(--neutral-500)',
        fontSize: themeTokens.typography.fontSize.xs,
      }}
    >
      {t('card.claimCta')}
    </MuiLink>
  );
}
