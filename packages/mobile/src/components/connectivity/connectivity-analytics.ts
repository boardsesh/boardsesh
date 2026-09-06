// Thin wrappers around the connectivity-banner events (issue #4862), so the hook
// stays free of property-key bookkeeping and every event ships the same shape.
//
// The question these are meant to answer is not "how often are we down" —
// Sentry and the backend already know that. It is "what does an outage cost a
// climber": how many changes were waiting when it started, how long the drain
// took once we were back, and how often it ended in a change we could not
// deliver at all.

import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../lib/analytics';
import type { BannerReason } from './connectivity-banner-state';

/**
 * How a recovery finished. `dismissed` and `interrupted` are not failures — they
 * are the reasons a drain has no end time, and pooling them into `timeout` would
 * make the timeout rate look far worse than it is.
 */
export type RecoveryOutcome = 'synced' | 'nothing_pending' | 'needs_retry' | 'timeout' | 'dismissed' | 'interrupted';

/**
 * Past ten taps the exact number stops telling us anything new — it only spreads
 * the distribution into a long tail of one-user buckets. Cap it and keep the
 * histogram readable.
 */
const RETRY_TAP_INDEX_CAP = 10;

export function trackBannerShown(props: { reason: BannerReason; pendingCount: number; signedIn: boolean }): void {
  track(SHARED_EVENTS.ConnectivityBannerShown, { ...props });
}

export function trackBannerDismissed(props: { reason: BannerReason; episodeMs: number; pendingCount: number }): void {
  track(SHARED_EVENTS.ConnectivityBannerDismissed, { ...props });
}

export function trackRetryTapped(props: {
  outcome: 'reachable' | 'unreachable' | 'unknown';
  episodeMs: number;
  /** 1-based tap number within this episode. */
  tapIndex: number;
}): void {
  track(SHARED_EVENTS.ConnectivityRetryTapped, { ...props, tapIndex: Math.min(props.tapIndex, RETRY_TAP_INDEX_CAP) });
}

export function trackRecovered(props: {
  reasonBefore: BannerReason;
  /** How long the outage itself lasted, start to reconnection. */
  episodeMs: number;
  pendingAtRecovery: number;
  /** How long the drain then took. Zero when nothing was queued. */
  drainMs: number;
  deadLettered: number;
  outcome: RecoveryOutcome;
}): void {
  track(SHARED_EVENTS.ConnectivityRecovered, { ...props });
}
