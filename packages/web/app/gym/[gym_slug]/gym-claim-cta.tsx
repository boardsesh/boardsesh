'use client';

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from 'next-auth/react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import VerifiedUserOutlined from '@mui/icons-material/VerifiedUserOutlined';
import { gymClaimCtaClicked } from '@boardsesh/analytics';
import ClaimGymDialog from '@/app/components/gym-entity/claim-gym-dialog';
import { trackGymFunnelEvent, viewerStateFromSessionStatus } from '@/app/lib/gym-funnel-analytics';
import { themeTokens } from '@/app/theme/theme-config';

type GymClaimCtaProps = {
  gymUuid: string;
  gymName: string;
  website?: string | null;
};

/**
 * Client island: the prominent "claim this gym" call-out on the public gym
 * page. The server only renders it when the viewer can actually claim the gym
 * (gym.canClaim), and it reuses the exact ClaimGymDialog the preview sheet opens.
 */
export default function GymClaimCta({ gymUuid, gymName, website }: GymClaimCtaProps) {
  const { t } = useTranslation('kiosk');
  const { status } = useSession();
  const [open, setOpen] = useState(false);

  return (
    <Box
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
      <Button
        variant="contained"
        startIcon={<VerifiedUserOutlined />}
        onClick={() => {
          trackGymFunnelEvent(
            gymClaimCtaClicked({
              placement: 'gym-page',
              viewerState: viewerStateFromSessionStatus(status),
              gymUuid,
            }),
          );
          setOpen(true);
        }}
        sx={{ textTransform: 'none' }}
      >
        {t('gymPage.claimCta')}
      </Button>
      <ClaimGymDialog
        gymUuid={gymUuid}
        gymName={gymName}
        website={website}
        open={open}
        onClose={() => setOpen(false)}
      />
    </Box>
  );
}
