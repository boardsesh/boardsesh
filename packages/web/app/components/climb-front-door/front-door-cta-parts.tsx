import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import OpenInBrowserIcon from '@mui/icons-material/OpenInBrowser';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import type { AppInstallPlacement } from '@/app/lib/app-install-event';
import type { QrLandingKind } from '@/app/lib/qr-landing';
import { themeTokens } from '@/app/theme/theme-config';
import type { StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import MobileStorePrimary from './mobile-store-primary';
import { STICKY_INSTALL_HIDE_ATTRIBUTE } from './sticky-install-markers';

// The pieces of a public page's phone-first call to action, without the QR
// card. `FrontDoorHeroCta` (climb page, board list) composes them on the
// server with `PhoneQrCard`; the playlist page composes them in its client
// component and takes the card as a server-rendered slot, so `qrcode.react`
// stays out of every client chunk. Nothing here imports the card.

/** MUI's `md`, where the pages turn into two columns. */
const DESKTOP_MEDIA = '@media (min-width: 900px)';

/** The block: one column, stretched on a phone and left-aligned from md. */
export const heroCtaBlockSx = {
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

type MobileInstallBlockProps = {
  /** The store badge's placement: its link id and `App Install Click`. */
  placement: AppInstallPlacement;
  /** Which code lands on this page, so the link id names it after a scan. */
  qrLanding?: QrLandingKind;
  /** The badges' own words and the page's language: `getStoreButtonLabels()` on the server. */
  labels: StoreButtonLabels;
  /** The line under the badge: what the app does with this page. */
  helper: string;
};

/**
 * Below md: the official badge of this phone's store, and a line saying what
 * the app does here, both centred. Hidden from md, where the QR card carries
 * the page to a phone instead.
 *
 * `data-cta="mobile-install"` names the block for the pages' tests; the sticky
 * install bar, where a page has one, hides while this block is on screen.
 */
export function MobileInstallBlock({ placement, qrLanding, labels, helper }: MobileInstallBlockProps) {
  return (
    <Box sx={mobileInstallSx} data-cta="mobile-install" {...{ [STICKY_INSTALL_HIDE_ATTRIBUTE]: '' }}>
      <MobileStorePrimary placement={placement} qrLanding={qrLanding} labels={labels} />
      <Typography component="p" sx={helperSx}>
        {helper}
      </Typography>
    </Box>
  );
}

const { '&:hover': filledHoverSx, ...filledSx } = brandCtaSx({ size: 'large' });

/**
 * The hover of a text button that looks filled. The theme gives every button
 * that is not `contained` a hover wash (`mui-theme.ts`:
 * `:not(:disabled):not(.MuiButton-contained):hover`, and `.MuiButton-textPrimary`
 * inside it for the text colour, specificity 0,5,0). This selector is 0,6,0, so
 * the fill wins whatever order the two rules land in.
 */
const FILLED_TEXT_BUTTON_HOVER = '&.MuiButton-root.MuiButton-text.MuiButton-colorPrimary:not(:disabled):hover';

/**
 * The hand-off's look: one anchor, two looks. Below md it is the quiet way out
 * under the store badge: a centred text link, with the theme's text-button
 * hover. From md it is the filled button, the page's one primary action on a
 * laptop, where the browser app works. The anchor stays `variant="text"` at
 * every width, so the page renders no `contained` button: on a phone the store
 * badge is the one primary action.
 */
export const handoffSx = {
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

type HandoffLabelsProps = {
  /** What a phone shows, a quiet text link: "Or open it in your browser". */
  mobile: string;
  /** What a laptop shows on the filled button: "Open in your browser". */
  desktop: string;
};

/**
 * The hand-off's words at each width, both in the HTML and picked by CSS. The
 * anchor gets no aria-label: the visible text at each width is the name
 * (WCAG 2.5.3).
 */
export function HandoffLabels({ mobile, desktop }: HandoffLabelsProps) {
  return (
    <>
      <Box component="span" sx={desktopIconSx}>
        <OpenInBrowserIcon aria-hidden />
      </Box>
      <Box component="span" sx={mobileOnlySx}>
        {mobile}
      </Box>
      <Box component="span" sx={desktopOnlySx}>
        {desktop}
      </Box>
    </>
  );
}

/** The QR card's wrapper: a laptop's, hidden below md where a phone is reading. */
export const desktopBlockSx = { display: { xs: 'none', md: 'block' }, width: '100%' };
