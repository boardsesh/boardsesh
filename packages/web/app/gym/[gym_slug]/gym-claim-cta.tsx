'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { gymClaimCtaClicked, type GymClaimPlacement, type GymClaimViewerState } from '@boardsesh/analytics';
import ClaimGymDialog from '@/app/components/gym-entity/claim-gym-dialog';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { trackGymFunnelEvent } from '@/app/lib/gym-funnel-analytics';
import { GymClaimCalloutBox } from './gym-claim-callout';
import { buildClaimReturnPath, shouldAutoOpenClaimDialog } from './gym-claim-cta-logic';
import { useGymClaimRequests } from './gym-claim-request';
import { useClaimParamStrip } from './use-claim-param-strip';

type GymClaimCtaProps = {
  gymUuid: string;
  gymName: string;
  gymSlug: string;
  website?: string | null;
  /** The gym's `canClaimByDomain`: whether the dialog opens on the work-email form. */
  canClaimByDomain: boolean;
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
  /** The call-out box's class: the page hides this copy below 960px, where a mirror sits above the boards. */
  className?: string;
};

/**
 * Client island: the prominent "claim this gym" call-out on the public gym
 * page. Both arms render the same box and the same copy, so an anonymous
 * visitor — the gym owner who just googled their own gym — gets the call-out
 * server-rendered and crawlable instead of gated behind a session.
 *
 * It owns the page's one claim flow (the dialog and the sign-in hop). The
 * call-out's phone copy and the run-by line under the H1 start it through
 * `requestGymClaim`, each with its own `placement`.
 */
export default function GymClaimCta({
  gymUuid,
  gymName,
  gymSlug,
  website,
  canClaimByDomain,
  viewerState,
  claimParam,
  className,
}: GymClaimCtaProps) {
  const { t } = useTranslation('kiosk');
  const { openAuthModal } = useAuthModal();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const returningFromAuth = shouldAutoOpenClaimDialog(claimParam);

  // The owner came back from OAuth on `?claim=1`: re-open the dialog they were
  // heading for. Immediate, unlike the URL cleanup below — a dialog that waits
  // a tick to appear reads as a dropped tap. Deps are server props, which the
  // cleanup's history swap doesn't change, so this settles after one run.
  useEffect(() => {
    if (viewerState !== 'signed-in' || !returningFromAuth) return;
    setOpen(true);
  }, [viewerState, returningFromAuth]);

  // Runs on both arms: the signed-out one lands here when someone opens a
  // shared `?claim=1` link, and the param is just as stale for them.
  useClaimParamStrip(returningFromAuth);

  const startClaim = (placement: GymClaimPlacement) => {
    trackGymFunnelEvent(gymClaimCtaClicked({ placement, viewerState, gymUuid }));

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

  useGymClaimRequests(gymUuid, startClaim);

  return (
    <>
      <GymClaimCalloutBox viewerState={viewerState} className={className} onClaim={() => startClaim('gym-page')} />
      <ClaimGymDialog
        gymUuid={gymUuid}
        gymName={gymName}
        website={website}
        canClaimByDomain={canClaimByDomain}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
