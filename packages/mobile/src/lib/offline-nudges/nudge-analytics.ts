// Thin wrappers around the offline-nudge events so the surfaces stay free of
// property-key bookkeeping. Every surface emits the same shape, separated by
// `surface`, so the funnel (shown → accepted → Offline Board Download Completed)
// can be split by where the suggestion appeared.

import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../analytics';
import type { NudgeSurface } from './nudge-policy';

export type NudgeEventContext = {
  surface: NudgeSurface;
  boardType: string;
  layoutId: number;
  scopeKey: string;
  /** How many scopes this device already holds — 0 means a first download. */
  downloadedBoardCount: number;
};

export function trackNudgeShown(context: NudgeEventContext): void {
  track(SHARED_EVENTS.OfflineNudgeShown, { ...context });
}

/**
 * What the accept actually DID, as reported by the surface that ran it. Never
 * derived from a connectivity probe: `useIsOffline()` reads ONLINE on
 * captive-portal wifi, which is the exact case the arm-only CTA was written
 * for, so a probe would file an arm as a started download.
 */
export type NudgeAcceptAction =
  /** The scope was marked only; the scheduler pulls it on the next reconnect. */
  | 'armed'
  /** A size dialog was confirmed and a real download started. */
  | 'download'
  /** The user was handed off to the screen where the download lives. */
  | 'handoff';

/**
 * `armedOnly` is load-bearing, not decoration: an armed accept produces no
 * download until the device reconnects, so without it the funnel reads as
 * accepts that never downloaded. A handoff is NOT armed — a download can follow
 * straight away — so the drop-off it leaves behind is real and worth counting.
 */
export function trackNudgeAccepted(context: NudgeEventContext, action: NudgeAcceptAction): void {
  track(SHARED_EVENTS.OfflineNudgeAccepted, { ...context, armedOnly: action === 'armed' });
}

export function trackNudgeDismissed(context: NudgeEventContext, dismissKind: 'once' | 'forever'): void {
  track(SHARED_EVENTS.OfflineNudgeDismissed, { ...context, dismissKind });
}
