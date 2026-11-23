import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { QRCodeSVG } from 'qrcode.react';
import StoreInstallButtons, { type StoreButtonLabels } from '@/app/components/marketing/store-install-buttons';
import type { AppInstallPlacement } from '@/app/lib/app-install-event';
import type { QrLandingKind } from '@/app/lib/qr-landing';
import { themeTokens } from '@/app/theme/theme-config';

// Dark modules on a white field, whatever the page theme: a phone camera reads
// that reliably, and a light code on a dark page is the one most scanners miss.
// SVG fills, like `PosterQr`, so no stylesheet can change them.
const QR_FOREGROUND = '#000000';
const QR_BACKGROUND = '#ffffff';
/**
 * Rendered size of the code, quiet zone included. A climb URL (100 to 150
 * characters with its slug and the `src`/`medium` pair) at level L is a 37 to
 * 45 module grid; with the 4-module quiet zone that is 2.8 to 3.4 CSS px a
 * module at 148px, which a phone camera reads off a laptop screen.
 */
const QR_SIZE = 148;
/** The quiet zone the QR spec asks for: 4 modules of white on every side, inside the code's own square. */
const QR_QUIET_ZONE_MODULES = 4;

type PhoneQrCardProps = {
  /** The absolute URL the code opens, with its `?src=qr&medium=…` pair. Build it with `climbQrUrl` and friends. */
  url: string;
  /** "Scan to open this climb on your phone", already translated. */
  title: string;
  /** One short line under the title. */
  body: string;
  /** What the code is, for a screen reader. */
  imageLabel: string;
  /** The store badges' placement: their link id and their `App Install Click`. */
  placement: AppInstallPlacement;
  storeLabels: StoreButtonLabels;
  /** Which kind of code lands on this page, so a store click after a scan names it. */
  qrLanding?: QrLandingKind;
};

const cardSx = {
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr)',
  alignItems: 'center',
  gap: `${themeTokens.spacing[4]}px`,
  // At its full 520 the card leaves a 324px text column beside the 148px code:
  // room for the two store badges side by side at 44px (292px, 299px in
  // French). In a narrower column they wrap onto two rows.
  maxWidth: 520,
  padding: `${themeTokens.spacing[3]}px ${themeTokens.spacing[5]}px ${themeTokens.spacing[3]}px ${themeTokens.spacing[3]}px`,
  backgroundColor: 'var(--semantic-surface)',
  border: '1px solid var(--separator)',
  borderRadius: `${themeTokens.borderRadius.xl}px`,
};

const codeSx = {
  width: QR_SIZE,
  height: QR_SIZE,
  overflow: 'hidden',
  borderRadius: `${themeTokens.borderRadius.md}px`,
  '& > svg': { display: 'block' },
};

const textColumnSx = { minWidth: 0 };

const titleSx = {
  margin: 0,
  color: 'var(--neutral-900)',
  fontWeight: themeTokens.typography.fontWeight.semibold,
  fontSize: themeTokens.typography.fontSize.base,
  lineHeight: themeTokens.typography.lineHeight.tight,
};

const bodySx = {
  margin: `${themeTokens.spacing[1]}px 0 ${themeTokens.spacing[3]}px`,
  color: 'var(--neutral-500)',
  fontSize: themeTokens.typography.fontSize.sm,
};

/**
 * A QR code that carries this page to the reader's phone, with the two store
 * badges beside it. For a laptop, where the page's button opens the browser
 * app: a phone with Boardsesh opens the code's link in the app, and one without
 * lands on the same page, whose first button on a phone is the store.
 *
 * Server-rendered, and it ships no JavaScript of its own. `qrcode.react`'s
 * `QRCodeSVG` uses `forwardRef` and `useMemo` and nothing else, both of which a
 * server component may call, so the code arrives as plain `<svg>` paths in the
 * HTML. The only island is `StoreInstallButtons`.
 *
 * The URL is the same for every reader (the page's own pathname plus the
 * `src`/`medium` pair), so the card is safe in HTML the edge stores for
 * everyone. It sets no breakpoint itself: the page hides it where a phone
 * would be reading it.
 */
export default function PhoneQrCard({
  url,
  title,
  body,
  imageLabel,
  placement,
  storeLabels,
  qrLanding,
}: PhoneQrCardProps) {
  return (
    <Box sx={cardSx}>
      <Box sx={codeSx}>
        <QRCodeSVG
          value={url}
          size={QR_SIZE}
          // L (7%): a screen is clean and flat, so spend the room on bigger
          // modules instead of error correction.
          level="L"
          marginSize={QR_QUIET_ZONE_MODULES}
          fgColor={QR_FOREGROUND}
          bgColor={QR_BACKGROUND}
          role="img"
          aria-label={imageLabel}
        />
      </Box>
      <Box sx={textColumnSx}>
        <Typography component="p" sx={titleSx}>
          {title}
        </Typography>
        <Typography component="p" sx={bodySx}>
          {body}
        </Typography>
        <StoreInstallButtons
          placement={placement}
          labels={storeLabels}
          appearance="plain"
          align="start"
          sharedHtml
          qrLanding={qrLanding}
        />
      </Box>
    </Box>
  );
}
