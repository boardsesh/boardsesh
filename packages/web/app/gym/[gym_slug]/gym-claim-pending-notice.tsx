import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import HourglassTopOutlined from '@mui/icons-material/HourglassTopOutlined';
import MarkEmailReadOutlined from '@mui/icons-material/MarkEmailReadOutlined';
import type { GymClaimMethod } from '@boardsesh/shared-schema';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { themeTokens } from '@/app/theme/theme-config';

type GymClaimPendingNoticeProps = {
  /** `gym.myPendingClaim.method` — which proof this claim is waiting on. */
  method: GymClaimMethod;
};

/**
 * Stands in for the claim call-out once this viewer has a claim in flight.
 * Server-rendered: the claim comes off the same request as the rest of the page,
 * so the notice is in the first HTML rather than appearing a beat later.
 *
 * The two methods wait on different things — an admin claim waits on a human,
 * a domain claim waits on the claimant clicking the link we emailed them — so
 * telling them apart is the difference between "sit tight" and "go check your
 * inbox".
 */
export default async function GymClaimPendingNotice({ method }: GymClaimPendingNoticeProps) {
  const { t } = await getServerTranslation('kiosk');
  const isDomainClaim = method === 'domain';

  return (
    <Box
      sx={{
        display: 'flex',
        gap: 1.5,
        border: '1px solid var(--neutral-200)',
        borderRadius: `${themeTokens.borderRadius.lg}px`,
        p: 2.5,
        mb: 3,
      }}
    >
      {isDomainClaim ? (
        <MarkEmailReadOutlined color="action" fontSize="small" />
      ) : (
        <HourglassTopOutlined color="action" fontSize="small" />
      )}
      <Box>
        <Typography variant="subtitle1" sx={{ fontWeight: themeTokens.typography.fontWeight.bold }}>
          {isDomainClaim ? t('gymPage.claimPendingDomainTitle') : t('gymPage.claimPendingTitle')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {isDomainClaim ? t('gymPage.claimPendingDomainBody') : t('gymPage.claimPendingBody')}
        </Typography>
      </Box>
    </Box>
  );
}
