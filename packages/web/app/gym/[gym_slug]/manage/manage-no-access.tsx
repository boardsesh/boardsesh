import React from 'react';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import LockOutlined from '@mui/icons-material/LockOutlined';
import ArrowBackOutlined from '@mui/icons-material/ArrowBackOutlined';
import type { Gym, MyGymClaim } from '@boardsesh/shared-schema';
import { getServerTranslation } from '@/app/lib/i18n/server';
import LocaleLink from '@/app/components/i18n/locale-link';
import { themeTokens } from '@/app/theme/theme-config';
import GymClaimPendingNotice from '../gym-claim-pending-notice';
import ManageNoAccessActions from './manage-no-access-actions';
import { gymClaimOpenToViewer, gymListingRunner, gymPageHref } from './manage-no-access-logic';

/**
 * Manage gym for a signed-in climber who can't manage this gym: who can change
 * it and what they can do instead, rather than a bare "no permission"
 * (docs/product/gym-board-governance.md, flow e). Claim this gym when the
 * listing is theirs to claim, Report a problem while the server takes reports,
 * and the way back to the gym's page. A viewer whose claim is already in
 * flight sees where it stands instead of a second Claim button.
 */
export default async function ManageNoAccess({
  gym,
  reportsEnabled,
  pendingClaim = null,
}: {
  gym: Gym;
  reportsEnabled: boolean;
  /** The viewer's own claim on this gym that hasn't been decided yet. */
  pendingClaim?: MyGymClaim | null;
}) {
  const { t } = await getServerTranslation('boards');
  const runner = gymListingRunner(gym);
  const claimOpen = gymClaimOpenToViewer(gym);
  // Where no claim can show, neither can the notice that stands in for one.
  const pending = claimOpen ? pendingClaim : null;
  // `canClaim` is a permission bit and stays true while a claim sits in the queue.
  const canClaim = claimOpen && pending === null;

  return (
    <Box>
      <Alert severity="info" icon={<LockOutlined />} sx={{ mb: 2 }}>
        <AlertTitle
          component="h1"
          sx={{ fontSize: themeTokens.typography.fontSize.lg, fontWeight: themeTokens.typography.fontWeight.semibold }}
        >
          {t('whoCanEdit.gymTitle')}
        </AlertTitle>
        <Typography variant="body2" sx={{ mb: 0.5 }}>
          {runner === 'staff'
            ? t('whoCanEdit.gymStaff', { gym: gym.name })
            : runner === 'climber'
              ? t('whoCanEdit.gymClimber', { name: gym.ownerDisplayName ?? '' })
              : runner === 'climber_hidden'
                ? t('whoCanEdit.gymClimberHidden')
                : t('whoCanEdit.gymUnclaimed')}
        </Typography>
        {canClaim && <Typography variant="body2">{t('whoCanEdit.claimHint')}</Typography>}
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('whoCanEdit.rule')}
        </Typography>
      </Alert>
      {pending && <GymClaimPendingNotice method={pending.method} />}
      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
        <ManageNoAccessActions
          gym={{
            uuid: gym.uuid,
            name: gym.name,
            slug: gym.slug ?? null,
            listingState: gym.listingState ?? null,
            canClaim,
            latitude: gym.latitude,
            longitude: gym.longitude,
            website: gym.website ?? null,
            canClaimByDomain: gym.canClaimByDomain,
          }}
          reportsEnabled={reportsEnabled}
        />
        <Button
          component={LocaleLink}
          href={gymPageHref(gym)}
          startIcon={<ArrowBackOutlined />}
          sx={{ textTransform: 'none', minHeight: 44 }}
        >
          {t('whoCanEdit.backToGym', { gym: gym.name })}
        </Button>
      </Box>
    </Box>
  );
}
