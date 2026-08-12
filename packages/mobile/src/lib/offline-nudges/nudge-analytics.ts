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
 * `armedOnly` is load-bearing, not decoration: offline the accept can only mark
 * the scope, so the download starts on the scheduler's next reconnect. Without
 * this the funnel reads as accepts that never produced a download.
 */
export function trackNudgeAccepted(context: NudgeEventContext, armedOnly: boolean): void {
  track(SHARED_EVENTS.OfflineNudgeAccepted, { ...context, armedOnly });
}

export function trackNudgeDismissed(context: NudgeEventContext, dismissKind: 'once' | 'forever'): void {
  track(SHARED_EVENTS.OfflineNudgeDismissed, { ...context, dismissKind });
}
