'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import VerifiedUserOutlined from '@mui/icons-material/VerifiedUserOutlined';
import type { GymClaimViewerState } from '@boardsesh/analytics';
import { themeTokens } from '@/app/theme/theme-config';
import { requestGymClaim } from './gym-claim-request';

type GymClaimCalloutBoxProps = {
  viewerState: GymClaimViewerState;
  onClaim: () => void;
  className?: string;
};

/** "Run this gym?" and its one button: the call-out's markup, shared by both of its places on the page. */
export function GymClaimCalloutBox({ viewerState, onClaim, className }: GymClaimCalloutBoxProps) {
  const { t } = useTranslation('kiosk');
  return (
    <Box
      className={className}
      sx={{
        border: '1px solid var(--neutral-200)',
        borderRadius: `${themeTokens.borderRadius.lg}px`,
        p: 2.5,
        mb: 3,
      }}
    >
      <Typography variant="subtitle1" sx={{ fontWeight: themeTokens.typography.fontWeight.bold }}>
        {t('gymPage.claimTitle')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>
        {t('gymPage.claimBody')}
      </Typography>
      <Button variant="contained" startIcon={<VerifiedUserOutlined />} onClick={onClaim} sx={{ textTransform: 'none' }}>
        {viewerState === 'signed-in' ? t('gymPage.claimCta') : t('gymPage.claimCtaSignedOut')}
      </Button>
    </Box>
  );
}

/**
 * The call-out's second copy, above the boards list. CSS shows it below 960px
 * and the details column's copy from 960px up (`gym-page.module.css`), so a
 * phone meets the claim before the boards and the install block, and a laptop
 * keeps it in the side column. Its button asks the details copy, which owns the
 * dialog, to start the claim.
 */
export default function GymClaimCalloutMirror({
  gymUuid,
  viewerState,
  className,
}: {
  gymUuid: string;
  viewerState: GymClaimViewerState;
  className?: string;
}) {
  return (
    <GymClaimCalloutBox
      viewerState={viewerState}
      className={className}
      onClaim={() => requestGymClaim(gymUuid, 'gym-page')}
    />
  );
}
