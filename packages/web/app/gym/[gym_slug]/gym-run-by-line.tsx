import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CheckCircleOutline from '@mui/icons-material/CheckCircleOutline';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import StorefrontOutlined from '@mui/icons-material/StorefrontOutlined';
import type { GymListingState } from '@boardsesh/shared-schema';
import GymRunByClaimLink from './gym-run-by-claim-link';

const LISTING_ICONS: Record<GymListingState, React.ReactNode> = {
  RUN_BY_GYM: <CheckCircleOutline sx={{ fontSize: 18, color: 'var(--color-success)' }} />,
  CLIMBER_LISTED: <PersonOutlined sx={{ fontSize: 18, color: 'var(--neutral-500)' }} />,
  UNCLAIMED: <StorefrontOutlined sx={{ fontSize: 18, color: 'var(--neutral-500)' }} />,
};

type GymRunByLineProps = {
  listingState: GymListingState;
  /** "Run by the gym", "Added by a climber" or "Not claimed yet", already translated. */
  label: string;
  /** "Run this gym? Claim it", only where the page offers this viewer a claim. */
  claim: { gymUuid: string; label: string } | null;
};

/**
 * Who runs this gym, right under its name (docs/product/gym-board-governance.md,
 * decision 4), and where the viewer may claim it, the way in. It sits in the
 * first screen on a phone, where the call-out further down does not.
 *
 * Server-rendered and the same for every viewer the claim offer is the same for:
 * the page already renders per viewer (it reads the session for `canClaim`), so
 * this adds no new reason to vary.
 */
export default function GymRunByLine({ listingState, label, claim }: GymRunByLineProps) {
  return (
    <Box
      data-testid="gym-run-by-line"
      sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: 1, rowGap: 0.5, mt: 1 }}
    >
      <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, minHeight: 44 }}>
        {LISTING_ICONS[listingState]}
        <Typography component="span" variant="body2" color="text.secondary">
          {label}
        </Typography>
      </Box>
      {claim && (
        <>
          <Box component="span" aria-hidden="true" sx={{ color: 'var(--neutral-400)' }}>
            ·
          </Box>
          <Typography component="span" variant="body2">
            <GymRunByClaimLink gymUuid={claim.gymUuid} label={claim.label} />
          </Typography>
        </>
      )}
    </Box>
  );
}
