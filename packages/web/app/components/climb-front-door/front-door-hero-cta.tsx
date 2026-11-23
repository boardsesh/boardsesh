import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import OpenInBrowserIcon from '@mui/icons-material/OpenInBrowser';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import type { StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import type { AppInstallPlacement } from '@/app/lib/app-install-event';
import type { QrLandingKind } from '@/app/lib/qr-landing';
import { themeTokens } from '@/app/theme/theme-config';
import { ClimbHandoffLink, type ClimbHandoffTarget } from './climb-handoff-cta';
import MobileStorePrimary, { type MobileStorePrimaryLabels } from './mobile-store-primary';
import PhoneQrCard from './phone-qr-card';
import { STICKY_INSTALL_HIDE_ATTRIBUTE } from './sticky-install-markers';

/** Every word the block shows, already translated by the server page. */
export type FrontDoorHeroCtaLabels = {
  store: MobileStorePrimaryLabels;
  /** The line under the phone's store button: what the app does with this page. */
  storeHelper: string;
  /** The hand-off as a phone shows it, a quiet text link: "Or open it in your browser". */
  handoffMobile: string;
  /** The hand-off as a laptop shows it, the filled button: "Open in your browser". */
  handoffDesktop: string;
  qr: { title: string; body: string; imageLabel: string };
};

type FrontDoorHeroCtaProps = {
  /** The phone's store button's placement: its link id and `App Install Click`. */
  placement: AppInstallPlacement;
  /** The QR card's store pair's own placement, so a laptop's store click reads apart from a phone's. */
  qrCardPlacement: AppInstallPlacement;
  /** Which code lands on this page, so the store link id names it after a scan. */
  qrLanding?: QrLandingKind;
  /** Where the hand-off opens (the pathname the reader is on) and what its `Climb Handoff Clicked` says. */
  handoff: ClimbHandoffTarget;
  /** The absolute URL the laptop's QR code opens: `climbQrUrl` or `listQrUrl`. */
  qrUrl: string;
  storeLabels: StoreButtonLabels;
  labels: FrontDoorHeroCtaLabels;
};

/** MUI's `md`, where the page turns into two columns. */
const DESKTOP_MEDIA = '@media (min-width: 900px)';

const blockSx = {
  display: 'grid',
  justifyItems: { xs: 'stretch', md: 'start' },
  gap: { xs: `${themeTokens.spacing[2]}px`, md: `${themeTokens.spacing[4]}px` },
};

const mobileInstallSx = {
  display: { xs: 'grid', md: 'none' },
  gap: `${themeTokens.spacing[3]}px`,
};

const helperSx = {
  margin: 0,
  color: 'var(--neutral-700)',
  fontSize: themeTokens.typography.fontSize.base,
  textAlign: 'center',
};

const { '&:hover': filledHoverSx, ...filledSx } = brandCtaSx({ size: 'large', glow: true });

/**
 * The hover of a text button that looks filled. The theme gives every button
 * that is not `contained` a violet wash on hover (`mui-theme.ts`:
 * `:not(:disabled):not(.MuiButton-contained):hover`, and `.MuiButton-colorPrimary`
 * inside it for the text colour, specificity 0,5,0). This selector is 0,6,0, so
 * the fill wins whatever order the two rules land in.
 */
const FILLED_TEXT_BUTTON_HOVER = '&.MuiButton-root.MuiButton-text.MuiButton-colorPrimary:not(:disabled):hover';

/**
 * One anchor, two looks. Below md it is the quiet way out under the store
 * button: a centred text link, with the theme's text-button hover. From md it
 * is the filled button, the page's one primary action on a laptop, where the
 * browser app works. It stays `variant="text"` at every width, so the store
 * button is the only `contained` one on the page.
 */
const handoffSx = {
  justifySelf: { xs: 'center', md: 'start' },
  minHeight: 44,
  paddingInline: `${themeTokens.spacing[3]}px`,
  textTransform: 'none',
  fontWeight: themeTokens.typography.fontWeight.semibold,
  fontSize: themeTokens.typography.fontSize.base,
  color: 'var(--color-primary)',
  [DESKTOP_MEDIA]: {
    ...filledSx,
    [FILLED_TEXT_BUTTON_HOVER]: { ...filledHoverSx, color: 'var(--color-on-primary)' },
  },
};

const mobileOnlySx = { display: { xs: 'inline', md: 'none' } };
const desktopOnlySx = { display: { xs: 'none', md: 'inline' } };
const desktopIconSx = { display: { xs: 'none', md: 'inline-flex' }, marginRight: `${themeTokens.spacing[2]}px` };
const desktopBlockSx = { display: { xs: 'none', md: 'block' }, width: '100%' };

/**
 * A public page's one call to action, split by screen width with CSS alone.
 * The climb page (`ClimbHeroCta`) and the board list (`StaticListFrontDoor`)
 * share it; each passes its own words, placement and hand-off.
 *
 * A phone reading these pages almost never has the app: a phone with it opens
 * climb links straight in the app, and a board list is mostly reached by
 * scanning a poster at the wall. So below md the one filled button is the store
 * ("Get the free app"), with a line saying what the app does here, and the
 * hand-off to the browser app drops to a text link. From md the hand-off is the
 * filled button, and a QR code beside it carries the page to a phone.
 *
 * One DOM for every reader: the pages are stored at the edge and handed to
 * everyone, so nothing here may depend on who asked. The split is `display`
 * only, which also means nothing moves once the page has painted.
 *
 * `data-cta` names the two blocks for the pages' tests: the store button is the
 * only filled button below md, inside `mobile-install`, and the hand-off is
 * `handoff`. `data-sticky-install-hide` tells a sticky install bar, where the
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
    <Box sx={blockSx}>
      <Box sx={mobileInstallSx} data-cta="mobile-install" {...{ [STICKY_INSTALL_HIDE_ATTRIBUTE]: '' }}>
        <MobileStorePrimary placement={placement} qrLanding={qrLanding} labels={labels.store} />
        <Typography component="p" sx={helperSx}>
          {labels.storeHelper}
        </Typography>
      </Box>

      {/* No aria-label: the visible text at each width is the name (WCAG 2.5.3). */}
      <ClimbHandoffLink {...handoff} ctaName="handoff" sx={handoffSx}>
        <Box component="span" sx={desktopIconSx}>
          <OpenInBrowserIcon aria-hidden />
        </Box>
        <Box component="span" sx={mobileOnlySx}>
          {labels.handoffMobile}
        </Box>
        <Box component="span" sx={desktopOnlySx}>
          {labels.handoffDesktop}
        </Box>
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
