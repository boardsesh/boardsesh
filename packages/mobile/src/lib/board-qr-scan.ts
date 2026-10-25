// A printed board code that opened the app (#4415).
//
// The poster and the kiosk encode `/b/{slug}?src=qr&medium=…`. A phone with the
// app installed opens the app on that URL instead of the www page, so www's
// tracker never sees the scan; the board route fires the same `Board QR
// Scanned` event with `surface: 'app'` once its handoff resolves the board.
//
// The event names no board: no slug, no name, no uuid, only the board type
// through `boardTypeProperty` (`docs/spray-walls.md`, "Telemetry").

import { boardQrScanned, parseGymQrLanding, type GymQrMedium } from '@boardsesh/analytics';
import { track } from './analytics';
import { createConsentBoundAnalyticsRunner } from './consent-bound-analytics';
import { isProductAnalyticsGranted } from './consent-state';

/** The route params a QR landing reads. A repeated param arrives as an array. */
export type BoardQrRouteParams = {
  src?: string | string[];
  medium?: string | string[];
};

/**
 * The medium a board URL says it was scanned from, or `null` when it was not a
 * scan. The strict www parser: `src` must be exactly `qr`, `medium` a known
 * value, and a repeated param of either is not a scan.
 */
export function boardQrScanMedium(params: BoardQrRouteParams): GymQrMedium | null {
  return parseGymQrLanding({ src: params.src, medium: params.medium })?.medium ?? null;
}

/**
 * Send one `Board QR Scanned` for a scan whose board the app has opened.
 *
 * A cold-start scan can resolve before the analytics SDK is ready. When consent
 * is already given, the capture waits for the SDK (the runner gives up after two
 * minutes); with no consent it is dropped, and a later Allow never replays it.
 */
export function trackBoardQrScan(medium: GymQrMedium, boardType: string | null | undefined): void {
  const event = boardQrScanned({ medium, surface: 'app', boardType });
  const capture = () => track(event.name, event.properties);
  if (isProductAnalyticsGranted()) {
    capture();
    return;
  }
  createConsentBoundAnalyticsRunner()(capture);
}
