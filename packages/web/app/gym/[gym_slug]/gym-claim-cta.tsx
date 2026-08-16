'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import VerifiedUserOutlined from '@mui/icons-material/VerifiedUserOutlined';
import { gymClaimCtaClicked, type GymClaimViewerState } from '@boardsesh/analytics';
import ClaimGymDialog from '@/app/components/gym-entity/claim-gym-dialog';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { trackGymFunnelEvent } from '@/app/lib/gym-funnel-analytics';
import { themeTokens } from '@/app/theme/theme-config';
import { CLAIM_PARAM, buildClaimReturnPath, shouldAutoOpenClaimDialog } from './gym-claim-cta-logic';

type GymClaimCtaProps = {
  gymUuid: string;
  gymName: string;
  gymSlug: string;
  website?: string | null;
  /**
   * Derived on the SERVER from the request's auth cookie and passed down, not
   * read here with `useSession()`. next-auth starts at `status: 'loading'` on
   * every page load and settles after a round-trip, so a tap that beats
   * hydration — the whole point of a QR poster — would report a signed-in
   * climber as signed-out.
   *
   * It also picks the arm: `signed-in` opens the claim dialog straight away,
   * `signed-out` sends the owner through auth first.
   */
  viewerState: GymClaimViewerState;
  /** The raw `?claim=` value, straight off the server's searchParams. */
  claimParam?: string | string[];
};

/**
 * Client island: the prominent "claim this gym" call-out on the public gym
 * page. Both arms render the same box and the same copy, so an anonymous
 * visitor — the gym owner who just googled their own gym — gets the call-out
 * server-rendered and crawlable instead of gated behind a session.
 */
export default function GymClaimCta({ gymUuid, gymName, gymSlug, website, viewerState, claimParam }: GymClaimCtaProps) {
  const { t } = useTranslation('kiosk');
  const { openAuthModal } = useAuthModal();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // The owner came back from OAuth on `?claim=1`. Re-open the dialog they were
  // heading for, then drop the param with a plain history swap: `router.replace`
  // refetches the RSC payload and remounts this island, closing the dialog it
  // was just called to open. Deps are server props, which a client-side history
  // swap doesn't change, so this settles after one run.
  useEffect(() => {
    if (viewerState !== 'signed-in' || !shouldAutoOpenClaimDialog(claimParam)) return;
    setOpen(true);
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.delete(CLAIM_PARAM);
    window.history.replaceState(null, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
  }, [viewerState, claimParam]);

  const handleClick = () => {
    trackGymFunnelEvent(gymClaimCtaClicked({ placement: 'gym-page', viewerState, gymUuid }));

    if (viewerState === 'signed-in') {
      setOpen(true);
      return;
    }

    openAuthModal({
      title: t('gymPage.claimAuthTitle'),
      description: t('gymPage.claimAuthBody'),
      // OAuth leaves the page entirely, so the intent has to survive in the URL.
      // Without it every social signer lands back on the homepage.
      callbackUrl: buildClaimReturnPath(gymSlug),
      onSuccess: () => {
        // Email/password never leaves the page, so open the dialog right here.
        setOpen(true);
        // `canClaim` is server-computed: refreshing with the fresh cookie clears
        // the call-out for an owner who turns out to already have edit access,
        // instead of letting them submit into a backend rejection.
        router.refresh();
      },
    });
  };

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
        onClick={handleClick}
        sx={{ textTransform: 'none' }}
      >
        {viewerState === 'signed-in' ? t('gymPage.claimCta') : t('gymPage.claimCtaSignedOut')}
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
