'use client';

import React from 'react';
import MuiLink from '@mui/material/Link';
import { themeTokens } from '@/app/theme/theme-config';
import { requestGymClaim } from './gym-claim-request';

/**
 * "Run this gym? Claim it" in the run-by line under the H1. It starts the same
 * claim flow as the call-out (sign-in first when signed out), counted as
 * `gym-page-header`. A button, not a link: nothing loads, a dialog opens.
 */
export default function GymRunByClaimLink({ gymUuid, label }: { gymUuid: string; label: string }) {
  return (
    <MuiLink
      component="button"
      type="button"
      underline="always"
      onClick={() => requestGymClaim(gymUuid, 'gym-page-header')}
      sx={{
        color: 'var(--color-primary)',
        fontWeight: themeTokens.typography.fontWeight.semibold,
        fontSize: 'inherit',
        minHeight: 44,
        textAlign: 'start',
      }}
    >
      {label}
    </MuiLink>
  );
}
