// A printed board code that opened the app (#4415).
//
// The poster and the kiosk encode `/b/{slug}?src=qr&medium=…`. A phone with the
// app installed opens the app on that URL instead of the www page, so www's
// tracker never sees the scan; the board route fires the same `Board QR
// Scanned` event with `surface: 'app'` once its handoff resolves the board.
//
// The event names no board: no slug, no name, no uuid, only the board type
// through `boardTypeProperty` (`docs/spray-walls.md`, "Telemetry").

import { boardQrScanned, parseBoardQrLanding, type BoardQrMedium } from '@boardsesh/analytics';
import { isAnalyticsGranted } from '@boardsesh/consent';
import { track } from './analytics';
import { AUTH_CONVERSION_WAIT_MS, createConsentBoundAnalyticsRunner } from './consent-bound-analytics';
import { getConsentSnapshot, isProductAnalyticsGranted } from './consent-state';
import { RELAXES_ANONYMOUS_ROUTES } from './routing/anonymous-auth-gate';

/**
 * How long one landing counts once. A signed-out cold-start scan can reach the
 * board route twice, once from the consent prompt's deferred destination and
 * once from the sign-in replay, and each mounts its own route screen, so the
 * screen's own guard cannot see the other one.
 */
export const BOARD_QR_SCAN_DEDUPE_MS = 60_000;
const recentLandings = new Map<string, number>();

/**
 * The one consent-bound runner holding scans until the SDK is ready. Each runner
 * subscribes to consent for up to `AUTH_CONVERSION_WAIT_MS`, so scans made while
 * the SDK is not ready share one instead of opening a subscription each. A new
 * one replaces it once its time is up or the signed-in account changes.
 */
type HeldRunner = { run: (capture: () => void) => void; authEpoch: number; expiresAt: number };
let heldRunner: HeldRunner | null = null;

function captureWhenSdkReady(capture: () => void): void {
  const snapshot = getConsentSnapshot();
  // No consent: dropped, and a later Allow never replays it.
  if (!snapshot.loaded || snapshot.killed || !isAnalyticsGranted(snapshot.record)) return;
  const nowMs = Date.now();
  if (!heldRunner || nowMs >= heldRunner.expiresAt || heldRunner.authEpoch !== snapshot.authEpoch) {
    heldRunner = {
      run: createConsentBoundAnalyticsRunner(),
      authEpoch: snapshot.authEpoch,
      expiresAt: nowMs + AUTH_CONVERSION_WAIT_MS,
    };
  }
  heldRunner.run(capture);
}

/** Tests only: forget recent landings and the held runner, as a new process would. */
export function resetBoardQrScansForTests(): void {
  recentLandings.clear();
  heldRunner = null;
}

/** Tests only: how many landings the dedupe window is holding. */
export function recentBoardQrScanCountForTests(): number {
  return recentLandings.size;
}

/** The route params a QR landing reads. A repeated param arrives as an array. */
export type BoardQrRouteParams = {
  src?: string | string[];
  medium?: string | string[];
};

/**
 * The medium a board URL says it was scanned from, or `null` when it was not a
 * scan of a board code. The strict shared parser (`parseBoardQrLanding`): `src`
 * must be exactly `qr`, `medium` one a board code prints (`kiosk`, `board`), and
 * a repeated param of either is not a scan.
 */
export function boardQrScanMedium(params: BoardQrRouteParams): BoardQrMedium | null {
  return parseBoardQrLanding({ src: params.src, medium: params.medium })?.medium ?? null;
}

/**
 * Send one `Board QR Scanned` for a scan whose board the app has opened.
 *
 * `landingKey` names the URL that opened it (never sent): the same landing
 * within {@link BOARD_QR_SCAN_DEDUPE_MS} counts once.
 *
 * A cold-start scan can resolve before the analytics SDK is ready.
 * `isProductAnalyticsGranted` is true only once consent is given AND the SDK is
 * ready, so that case sends at once. Otherwise, with consent already given, one
 * shared consent-bound runner holds the capture until the SDK is ready (it gives
 * up after two minutes); with no consent it is dropped, and a later Allow never
 * replays it.
 *
 * The browser app sends nothing: `surface: 'app'` is the store app, and a
 * printed code never points at the browser app.
 */
export function trackBoardQrScan(
  medium: BoardQrMedium,
  boardType: string | null | undefined,
  landingKey: string,
  nowMs: number = Date.now(),
): void {
  if (RELAXES_ANONYMOUS_ROUTES) return;
  // Forget landings outside the window so the map holds only live ones.
  for (const [key, countedAt] of recentLandings) {
    if (nowMs - countedAt >= BOARD_QR_SCAN_DEDUPE_MS || nowMs < countedAt) recentLandings.delete(key);
  }
  const dedupeKey = `${landingKey}#${medium}`;
  if (recentLandings.has(dedupeKey)) return;
  recentLandings.set(dedupeKey, nowMs);

  const event = boardQrScanned({ medium, surface: 'app', boardType });
  const capture = () => track(event.name, event.properties);
  if (isProductAnalyticsGranted()) {
    capture();
    return;
  }
  captureWhenSdkReady(capture);
}
