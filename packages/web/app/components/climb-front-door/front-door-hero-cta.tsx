import React from 'react';
import Box from '@mui/material/Box';
import type { StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import type { AppInstallPlacement } from '@/app/lib/app-install-event';
import type { QrLandingKind } from '@/app/lib/qr-landing';
import { ClimbHandoffLink, type ClimbHandoffTarget } from './climb-handoff-cta';
import { desktopBlockSx, HandoffLabels, handoffSx, heroCtaBlockSx, MobileInstallBlock } from './front-door-cta-parts';
import PhoneQrCard from './phone-qr-card';

/** Every word the block shows, already translated by the server page. */
export type FrontDoorHeroCtaLabels = {
  /** The line under the phone's store badge: what the app does with this page. */
  storeHelper: string;
  /** The hand-off as a phone shows it, a quiet text link: "Or open it in your browser". */
  handoffMobile: string;
  /** The hand-off as a laptop shows it, the filled button: "Open in your browser". */
  handoffDesktop: string;
  qr: { title: string; body: string; imageLabel: string };
};

type FrontDoorHeroCtaProps = {
  /** The phone's store badge's placement: its link id and `App Install Click`. */
  placement: AppInstallPlacement;
  /** The QR card's store pair's own placement, so a laptop's store click reads apart from a phone's. */
  qrCardPlacement: AppInstallPlacement;
  /** Which code lands on this page, so the store link id names it after a scan. */
  qrLanding?: QrLandingKind;
  /** Where the hand-off opens (the pathname the reader is on) and what its `Climb Handoff Clicked` says. */
  handoff: ClimbHandoffTarget;
  /** The absolute URL the laptop's QR code opens: `climbQrUrl` or `listQrUrl`. */
  qrUrl: string;
  /** The badges' own words and the page's language, for the phone's badge and the QR card's pair. */
  storeLabels: StoreButtonLabels;
  labels: FrontDoorHeroCtaLabels;
};

/**
 * A public page's one call to action, split by screen width with CSS alone.
 * The climb page (`ClimbHeroCta`) and the board list (`StaticListFrontDoor`)
 * share it; each passes its own words, placement and hand-off. The parts live
 * in `front-door-cta-parts.tsx`, which the playlist page composes too.
 *
 * A phone reading these pages almost never has the app: a phone with it opens
 * climb links straight in the app, and a board list is mostly reached by
 * scanning a poster at the wall. So below md the primary action is the official
 * badge of the phone's store, with a line saying what the app does here, and
 * the hand-off to the browser app drops to a text link. From md the hand-off is
 * the filled button, and a QR code beside it carries the page to a phone.
 *
 * One DOM for every reader: the pages are stored at the edge and handed to
 * everyone, so nothing here may depend on who asked. The split is `display`
 * only, which also means nothing moves once the page has painted.
 *
 * `data-cta` names the two blocks for the pages' tests: the phone's store badge
 * is inside `mobile-install`, and the hand-off is `handoff`. `data-sticky-install-hide` tells a sticky install bar, where the
 * page has one, that this block is on screen.
 */
export default function FrontDoorHeroCta({
  placement,
  qrCardPlacement,
  qrLanding,
  handoff,
  qrUrl,
  storeLabels,
  labels,
}: FrontDoorHeroCtaProps) {
  return (
    <Box sx={heroCtaBlockSx}>
      <MobileInstallBlock
        placement={placement}
        qrLanding={qrLanding}
        labels={storeLabels}
        helper={labels.storeHelper}
      />

      <ClimbHandoffLink {...handoff} ctaName="handoff" sx={handoffSx}>
        <HandoffLabels mobile={labels.handoffMobile} desktop={labels.handoffDesktop} />
      </ClimbHandoffLink>

      <Box sx={desktopBlockSx}>
        <PhoneQrCard
          url={qrUrl}
          title={labels.qr.title}
          body={labels.qr.body}
          imageLabel={labels.qr.imageLabel}
          placement={qrCardPlacement}
          storeLabels={storeLabels}
          qrLanding={qrLanding}
        />
      </Box>
    </Box>
  );
}
