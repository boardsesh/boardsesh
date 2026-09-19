'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MuiLink from '@mui/material/Link';
import { gymClaimCtaClicked, type GymClaimViewerState } from '@boardsesh/analytics';
import { trackGymFunnelEvent } from '@/app/lib/gym-funnel-analytics';
import { themeTokens } from '@/app/theme/theme-config';

type GymDirectoryClaimLinkProps = {
  /**
   * Settled on the SERVER from the request's auth cookie, never with
   * `useSession()` — next-auth starts every page load at `loading`, and a click
   * that beats the round-trip would report a signed-in climber as signed-out.
   */
  viewerState: GymClaimViewerState;
};

/**
 * The directory's ONE claim prompt, under the list.
 *
 * It used to sit on every unclaimed row, which made "Is this your gym?" the
 * most repeated line on the page — 24 of them under a list of 24 gyms, each one
 * reading like a warning on a listing rather than an invitation to an owner.
 * Once per page says the same thing and says it to the same person.
 *
 * The link is an in-page jump to the search box, not a link to a gym: claiming
 * starts on a gym's own page, and one prompt under 24 gyms cannot know which
 * gym is yours. A real `<a href="#…">` rather than a scroll handler, so it
 * works with JS off and a middle-click still does something sensible.
 */
export default function GymDirectoryClaimLink({ viewerState }: GymDirectoryClaimLinkProps) {
  const { t } = useTranslation('gyms');

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
      <Typography variant="body2" color="text.secondary">
        {t('claim.body')}
      </Typography>
      <MuiLink
        href="#gym-directory-search"
        // `always`, not `hover`: at rest this link was `--neutral-500` with no
        // underline, i.e. pixel-identical to the secondary sentence beside it.
        // Colour plus a permanent underline is what makes it a link without
        // relying on colour alone (WCAG 1.4.1).
        underline="always"
        onClick={() => {
          // `directory-footer`, not the old `directory-card`: the prompt is no
          // longer per row, so the two values count different things.
          trackGymFunnelEvent(gymClaimCtaClicked({ placement: 'directory-footer', viewerState, gymUuid: null }));
        }}
        sx={{
          color: 'var(--color-primary)',
          fontSize: themeTokens.typography.fontSize.sm,
          fontWeight: themeTokens.typography.fontWeight.semibold,
          display: 'inline-flex',
          alignItems: 'center',
          minHeight: 44,
        }}
      >
        {t('claim.action')}
      </MuiLink>
    </Box>
  );
}
