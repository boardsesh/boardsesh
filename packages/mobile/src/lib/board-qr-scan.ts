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
import { RELAXES_ANONYMOUS_ROUTES } from './routing/anonymous-auth-gate';

/**
 * How long one landing counts once. A signed-out cold-start scan can reach the
 * board route twice, once from the consent prompt's deferred destination and
 * once from the sign-in replay, and each mounts its own route screen, so the
 * screen's own guard cannot see the other one.
 */
export const BOARD_QR_SCAN_DEDUPE_MS = 60_000;
const recentLandings = new Map<string, number>();

/** Tests only: forget recent landings, as a new process would. */
export function resetBoardQrScansForTests(): void {
  recentLandings.clear();
}

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
 * `landingKey` names the URL that opened it (never sent): the same landing
 * within {@link BOARD_QR_SCAN_DEDUPE_MS} counts once.
 *
 * A cold-start scan can resolve before the analytics SDK is ready. When consent
 * is already given, the capture waits for the SDK (the runner gives up after two
 * minutes); with no consent it is dropped, and a later Allow never replays it.
 *
 * The browser app sends nothing: `surface: 'app'` is the store app, and a
 * printed code never points at the browser app.
 */
export function trackBoardQrScan(
  medium: GymQrMedium,
  boardType: string | null | undefined,
  landingKey: string,
  nowMs: number = Date.now(),
): void {
  if (RELAXES_ANONYMOUS_ROUTES) return;
  const dedupeKey = `${landingKey}#${medium}`;
  const countedAt = recentLandings.get(dedupeKey);
  if (countedAt !== undefined && nowMs - countedAt >= 0 && nowMs - countedAt < BOARD_QR_SCAN_DEDUPE_MS) return;
  recentLandings.set(dedupeKey, nowMs);

  const event = boardQrScanned({ medium, surface: 'app', boardType });
  const capture = () => track(event.name, event.properties);
  if (isProductAnalyticsGranted()) {
    capture();
    return;
  }
  createConsentBoundAnalyticsRunner()(capture);
}
