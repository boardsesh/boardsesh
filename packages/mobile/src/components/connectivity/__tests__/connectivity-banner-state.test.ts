// The connectivity banner's life cycle (issue #4862). Every rule the banner
// makes a promise about is pinned here: it never hides itself while the app is
// offline, it never claims "All synced" over a queue that dead-lettered, and the
// only thing that says "we are back" is the connectivity store.

import { describe, it, expect } from 'vitest';
import {
  BANNER_TIMING,
  nextTickDelayMs,
  reduceBanner,
  type BannerEvent,
  type BannerReason,
  type BannerState,
} from '../connectivity-banner-state';

const T0 = 1_000_000;

const hidden: BannerState = { kind: 'hidden' };

function offlineAt(reason: BannerReason, since: number, now = since): BannerEvent {
  return { type: 'connectivity', effectiveOffline: true, reason, since, now };
}

function onlineAt(now: number): BannerEvent {
  return { type: 'connectivity', effectiveOffline: false, reason: null, since: null, now };
}

function outboxAt(pendingCount: number, deadLetterCount: number, now: number): BannerEvent {
  return { type: 'outbox', pendingCount, deadLetterCount, now };
}

/** Replay a script from `hidden`, which is how the banner always starts. */
function run(events: BannerEvent[], from: BannerState = hidden): BannerState {
  return events.reduce((state, event) => reduceBanner(state, event), from);
}

function expectActive(state: BannerState) {
  if (state.kind !== 'active') throw new Error(`expected active, got ${state.kind}`);
  return state;
}

function expectRecovering(state: BannerState) {
  if (state.kind !== 'recovering') throw new Error(`expected recovering, got ${state.kind}`);
  return state;
}

describe('opening an episode', () => {
  it('opens expanded on the outage start the store reports', () => {
    const state = expectActive(reduceBanner(hidden, offlineAt('backend_unreachable', T0, T0 + 50)));

    expect(state.reason).toBe('backend_unreachable');
    expect(state.since).toBe(T0);
    expect(state.expanded).toBe(true);
    expect(state.retry).toBe('idle');
    expect(state.retryTaps).toBe(0);
  });

  it('falls back to now when the store has not stamped a start', () => {
    const state = expectActive(
      reduceBanner(hidden, {
        type: 'connectivity',
        effectiveOffline: true,
        reason: 'device_offline',
        since: null,
        now: T0,
      }),
    );

    expect(state.since).toBe(T0);
  });

  it('re-publishing the same episode changes nothing, so a collapsed card stays collapsed', () => {
    const collapsed = run([offlineAt('backend_unreachable', T0), { type: 'dismiss' }]);
    expect(expectActive(collapsed).expanded).toBe(false);

    const republished = reduceBanner(collapsed, offlineAt('backend_unreachable', T0, T0 + 5_000));

    expect(republished).toBe(collapsed);
  });

  it('re-expands on a new start time — that is a second outage, not the same one', () => {
    const collapsed = run([offlineAt('device_offline', T0), { type: 'dismiss' }]);

    const next = expectActive(reduceBanner(collapsed, offlineAt('device_offline', T0 + 60_000)));

    expect(next.expanded).toBe(true);
    expect(next.since).toBe(T0 + 60_000);
  });

  it('re-expands when the reason changes under the same start', () => {
    const collapsed = run([offlineAt('device_offline', T0), { type: 'dismiss' }]);

    const next = expectActive(reduceBanner(collapsed, offlineAt('backend_unreachable', T0)));

    expect(next.reason).toBe('backend_unreachable');
    expect(next.expanded).toBe(true);
  });

  it('carries the queued count into a new episode so the card opens with a number', () => {
    const withCount = run([offlineAt('backend_unreachable', T0), outboxAt(3, 0, T0 + 100)]);

    const next = expectActive(reduceBanner(withCount, offlineAt('device_offline', T0 + 200)));

    expect(next.pendingCount).toBe(3);
    expect(next.retryTaps).toBe(0);
  });
});

describe('auto-collapse', () => {
  it('collapses "no signal" once the climber has had time to read it', () => {
    const opened = run([offlineAt('device_offline', T0)]);

    const early = reduceBanner(opened, { type: 'tick', now: T0 + BANNER_TIMING.DEVICE_OFFLINE_COLLAPSE_MS - 1 });
    expect(expectActive(early).expanded).toBe(true);

    const late = reduceBanner(opened, { type: 'tick', now: T0 + BANNER_TIMING.DEVICE_OFFLINE_COLLAPSE_MS });
    expect(expectActive(late).expanded).toBe(false);
  });

  it('measures the window from when the card opened, not from a stale outage start', () => {
    // The store stamps `unreachableSince` when the outage began, which can be
    // minutes old by the time the banner mounts (a cold start into an outage).
    const staleSince = T0 - 10 * 60_000;
    const opened = run([offlineAt('device_offline', staleSince, T0)]);
    expect(expectActive(opened).expandedAt).toBe(T0);

    const stillReadable = reduceBanner(opened, {
      type: 'tick',
      now: T0 + BANNER_TIMING.DEVICE_OFFLINE_COLLAPSE_MS - 1,
    });
    expect(expectActive(stillReadable).expanded).toBe(true);
  });

  it('never auto-collapses server trouble or offline mode', () => {
    for (const reason of ['backend_unreachable', 'offline_mode'] as const) {
      const opened = run([offlineAt(reason, T0)]);
      const later = reduceBanner(opened, { type: 'tick', now: T0 + BANNER_TIMING.DEVICE_OFFLINE_COLLAPSE_MS * 10 });

      expect(expectActive(later).expanded).toBe(true);
    }
  });
});

describe('dismiss', () => {
  it('only collapses a live outage — the banner never hides while offline', () => {
    for (const reason of ['backend_unreachable', 'device_offline', 'offline_mode'] as const) {
      const dismissed = run([offlineAt(reason, T0), { type: 'dismiss' }]);

      expect(dismissed.kind).toBe('active');
      expect(expectActive(dismissed).expanded).toBe(false);
    }
  });

  it('is a no-op on an already collapsed card', () => {
    const collapsed = run([offlineAt('device_offline', T0), { type: 'dismiss' }]);

    expect(reduceBanner(collapsed, { type: 'dismiss' })).toBe(collapsed);
  });

  it('hides the resolved states, which are not holding anything back', () => {
    const synced = run([offlineAt('backend_unreachable', T0), onlineAt(T0 + 100)]);
    expect(synced.kind).toBe('synced');
    expect(reduceBanner(synced, { type: 'dismiss' })).toEqual(hidden);

    const needsRetry = run([
      offlineAt('backend_unreachable', T0),
      outboxAt(2, 0, T0 + 10),
      onlineAt(T0 + 100),
      outboxAt(0, 1, T0 + 500),
    ]);
    expect(needsRetry.kind).toBe('needs_retry');
    expect(reduceBanner(needsRetry, { type: 'dismiss' })).toEqual(hidden);
  });

  it('re-expands from the pill and restarts the reading window', () => {
    const collapsed = run([offlineAt('device_offline', T0), { type: 'dismiss' }]);

    // Well past the episode's original collapse deadline: a climber who taps the
    // pill an hour into an outage still gets the full window to read it.
    const reopenedAt = T0 + 60 * 60_000;
    const reopened = expectActive(reduceBanner(collapsed, { type: 'expand', now: reopenedAt }));
    expect(reopened.expanded).toBe(true);
    expect(reopened.expandedAt).toBe(reopenedAt);

    // The very next tick must NOT collapse it again — anchoring the window to
    // the episode's `since` is exactly what made the pill untappable.
    const justAfter = reduceBanner(reopened, { type: 'tick', now: reopenedAt + 1 });
    expect(expectActive(justAfter).expanded).toBe(true);

    const nearlyDue = reduceBanner(reopened, {
      type: 'tick',
      now: reopenedAt + BANNER_TIMING.DEVICE_OFFLINE_COLLAPSE_MS - 1,
    });
    expect(expectActive(nearlyDue).expanded).toBe(true);

    const due = reduceBanner(reopened, {
      type: 'tick',
      now: reopenedAt + BANNER_TIMING.DEVICE_OFFLINE_COLLAPSE_MS,
    });
    expect(expectActive(due).expanded).toBe(false);
  });
});

describe('retry', () => {
  const opened = run([offlineAt('backend_unreachable', T0)]);

  it('counts a tap and shows it in flight', () => {
    const started = expectActive(reduceBanner(opened, { type: 'retry_started' }));

    expect(started.retry).toBe('inFlight');
    expect(started.retryTaps).toBe(1);
  });

  it('ignores a second tap while a probe is in flight, tap count included', () => {
    const started = reduceBanner(opened, { type: 'retry_started' });

    expect(reduceBanner(started, { type: 'retry_started' })).toBe(started);
  });

  it('says "still down" on a failed probe and offers the button again later', () => {
    const started = reduceBanner(opened, { type: 'retry_started' });
    const failed = expectActive(reduceBanner(started, { type: 'retry_result', backend: 'unreachable', now: T0 + 900 }));

    expect(failed.retry).toBe('stillDown');
    expect(failed.retryAt).toBe(T0 + 900);

    const stillEarly = reduceBanner(failed, { type: 'tick', now: T0 + 900 + BANNER_TIMING.STILL_DOWN_MS - 1 });
    expect(expectActive(stillEarly).retry).toBe('stillDown');

    const cleared = expectActive(reduceBanner(failed, { type: 'tick', now: T0 + 900 + BANNER_TIMING.STILL_DOWN_MS }));
    expect(cleared.retry).toBe('idle');
    expect(cleared.retryAt).toBeNull();
  });

  it('treats an inconclusive probe as "still down", never as recovery', () => {
    const started = reduceBanner(opened, { type: 'retry_started' });
    const unknown = expectActive(reduceBanner(started, { type: 'retry_result', backend: 'unknown', now: T0 + 900 }));

    expect(unknown.retry).toBe('stillDown');
  });

  it('lets the connectivity store — not the probe result — declare recovery', () => {
    const started = reduceBanner(opened, { type: 'retry_started' });

    expect(reduceBanner(started, { type: 'retry_result', backend: 'reachable', now: T0 + 900 })).toBe(started);
  });

  it('resets the tap count for the next episode', () => {
    const tapped = run(
      [{ type: 'retry_started' }, { type: 'retry_result', backend: 'unreachable', now: T0 + 900 }],
      opened,
    );
    expect(expectActive(tapped).retryTaps).toBe(1);

    const nextEpisode = reduceBanner(tapped, offlineAt('backend_unreachable', T0 + 50_000));

    expect(expectActive(nextEpisode).retryTaps).toBe(0);
    expect(expectActive(nextEpisode).retry).toBe('idle');
  });
});

describe('recovery', () => {
  it('goes straight to "all synced" when nothing was queued', () => {
    const state = run([offlineAt('backend_unreachable', T0), onlineAt(T0 + 5_000)]);

    expect(state).toEqual({
      kind: 'synced',
      recoveredAt: T0 + 5_000,
      settledAt: T0 + 5_000,
      outcome: 'nothing_pending',
    });
  });

  it('watches the drain when writes are waiting', () => {
    const drainWatch = run([offlineAt('device_offline', T0), outboxAt(4, 0, T0 + 10), onlineAt(T0 + 5_000)]);
    const state = expectRecovering(drainWatch);

    expect(state.reasonBefore).toBe('device_offline');
    expect(state.since).toBe(T0);
    expect(state.pendingAtRecovery).toBe(4);
    expect(state.pendingCount).toBe(4);
  });

  it('counts down as the drainer works', () => {
    const recovering = run([offlineAt('device_offline', T0), outboxAt(4, 0, T0 + 10), onlineAt(T0 + 5_000)]);

    const partway = expectRecovering(reduceBanner(recovering, outboxAt(2, 0, T0 + 5_200)));
    expect(partway.pendingCount).toBe(2);
    expect(partway.pendingAtRecovery).toBe(4);
  });

  it('lands on "all synced" when the queue empties cleanly', () => {
    const state = run([
      offlineAt('device_offline', T0),
      outboxAt(4, 0, T0 + 10),
      onlineAt(T0 + 5_000),
      outboxAt(0, 0, T0 + 6_000),
    ]);

    expect(state).toEqual({ kind: 'synced', recoveredAt: T0 + 5_000, settledAt: T0 + 6_000, outcome: 'synced' });
  });

  it('says a change needs a retry when the drain gave up on one', () => {
    const state = run([
      offlineAt('backend_unreachable', T0),
      outboxAt(3, 0, T0 + 10),
      onlineAt(T0 + 5_000),
      outboxAt(0, 2, T0 + 6_000),
    ]);

    expect(state).toEqual({ kind: 'needs_retry', deadLettered: 2, pendingCount: 0 });
  });

  it('blames this drain for its OWN dead letters only', () => {
    // One row was already dead-lettered before the outage — a standing problem
    // the sync-issues screen owns. A clean drain on top of it is still a success.
    const state = run([
      offlineAt('backend_unreachable', T0),
      outboxAt(3, 1, T0 + 10),
      onlineAt(T0 + 5_000),
      outboxAt(0, 1, T0 + 6_000),
    ]);

    expect(state.kind).toBe('synced');
  });

  it('gives up on a drain that never finishes', () => {
    const recovering = run([offlineAt('device_offline', T0), outboxAt(4, 0, T0 + 10), onlineAt(T0 + 5_000)]);

    const early = reduceBanner(recovering, {
      type: 'tick',
      now: T0 + 5_000 + BANNER_TIMING.RECOVERY_TIMEOUT_MS - 1,
    });
    expect(early.kind).toBe('recovering');

    const timedOut = reduceBanner(recovering, { type: 'tick', now: T0 + 5_000 + BANNER_TIMING.RECOVERY_TIMEOUT_MS });
    expect(timedOut).toEqual(hidden);
  });

  it('clears "all synced" on its own', () => {
    const synced = run([offlineAt('backend_unreachable', T0), onlineAt(T0 + 5_000)]);

    const early = reduceBanner(synced, { type: 'tick', now: T0 + 5_000 + BANNER_TIMING.SYNCED_HIDE_MS - 1 });
    expect(early.kind).toBe('synced');

    const gone = reduceBanner(synced, { type: 'tick', now: T0 + 5_000 + BANNER_TIMING.SYNCED_HIDE_MS });
    expect(gone).toEqual(hidden);
  });

  it('clears "needs a retry" once the dead letters are gone', () => {
    const needsRetry = run([
      offlineAt('backend_unreachable', T0),
      outboxAt(2, 0, T0 + 10),
      onlineAt(T0 + 5_000),
      outboxAt(0, 2, T0 + 6_000),
    ]);
    expect(needsRetry).toEqual({ kind: 'needs_retry', deadLettered: 2, pendingCount: 0 });

    // Retried one from the sync-issues screen…
    const partlyFixed = reduceBanner(needsRetry, outboxAt(0, 1, T0 + 20_000));
    expect(partlyFixed).toEqual({ kind: 'needs_retry', deadLettered: 1, pendingCount: 0 });

    // …then the last one. Nothing left to warn about.
    expect(reduceBanner(partlyFixed, outboxAt(0, 0, T0 + 30_000))).toEqual(hidden);
  });

  it('never inflates the dead-letter count from an unrelated row', () => {
    const needsRetry = run([
      offlineAt('backend_unreachable', T0),
      outboxAt(1, 0, T0 + 10),
      onlineAt(T0 + 5_000),
      outboxAt(0, 1, T0 + 6_000),
    ]);

    // Some other write dead-lettered later; this drain still only gave up on one.
    const later = reduceBanner(needsRetry, outboxAt(0, 3, T0 + 20_000));

    expect(later).toEqual({ kind: 'needs_retry', deadLettered: 1, pendingCount: 0 });
  });

  it('keeps "needs a retry" up until the climber deals with it', () => {
    const needsRetry = run([
      offlineAt('backend_unreachable', T0),
      outboxAt(1, 0, T0 + 10),
      onlineAt(T0 + 5_000),
      outboxAt(0, 1, T0 + 6_000),
    ]);

    expect(reduceBanner(needsRetry, { type: 'tick', now: T0 + 10 * 60_000 })).toBe(needsRetry);
    expect(reduceBanner(needsRetry, onlineAt(T0 + 7_000))).toBe(needsRetry);
  });
});

describe('offline with no reason', () => {
  // The store can briefly report `effectiveOffline` before it has decided WHY.
  // That names no copy and no icon, and must never be read as "back online".
  const reasonless: BannerEvent = {
    type: 'connectivity',
    effectiveOffline: true,
    reason: null,
    since: T0,
    now: T0 + 100,
  };

  it('holds a live outage instead of faking a recovery', () => {
    const opened = run([offlineAt('backend_unreachable', T0), outboxAt(2, 0, T0 + 10)]);

    expect(reduceBanner(opened, reasonless)).toBe(opened);
  });

  it('opens nothing from hidden', () => {
    expect(reduceBanner(hidden, reasonless)).toEqual(hidden);
  });
});

describe('a second outage interrupts recovery', () => {
  it('reopens from recovering', () => {
    const recovering = run([offlineAt('device_offline', T0), outboxAt(4, 0, T0 + 10), onlineAt(T0 + 5_000)]);

    const interrupted = expectActive(reduceBanner(recovering, offlineAt('device_offline', T0 + 5_500)));

    expect(interrupted.since).toBe(T0 + 5_500);
    expect(interrupted.expanded).toBe(true);
    expect(interrupted.pendingCount).toBe(4);
  });

  it('reopens from synced and from needs_retry', () => {
    const synced = run([offlineAt('backend_unreachable', T0), onlineAt(T0 + 5_000)]);
    expect(reduceBanner(synced, offlineAt('backend_unreachable', T0 + 6_000)).kind).toBe('active');

    const needsRetry = run([
      offlineAt('backend_unreachable', T0),
      outboxAt(1, 0, T0 + 10),
      onlineAt(T0 + 5_000),
      outboxAt(0, 1, T0 + 6_000),
    ]);
    const reopened = expectActive(reduceBanner(needsRetry, offlineAt('backend_unreachable', T0 + 7_000)));
    expect(reopened.deadLetterCount).toBe(1);
  });
});

describe('hidden absorbs everything while online', () => {
  const noise: BannerEvent[] = [
    onlineAt(T0),
    outboxAt(5, 2, T0),
    { type: 'dismiss' },
    { type: 'expand', now: T0 },
    { type: 'retry_started' },
    { type: 'retry_result', backend: 'unreachable', now: T0 },
    { type: 'tick', now: T0 + 10 * 60_000 },
  ];

  it('stays hidden', () => {
    for (const event of noise) {
      expect(reduceBanner(hidden, event)).toEqual(hidden);
    }
    expect(run(noise)).toEqual(hidden);
  });
});

describe('no-op events keep the same object', () => {
  it('an unchanged outbox read does not churn the state', () => {
    const opened = run([offlineAt('backend_unreachable', T0), outboxAt(2, 0, T0 + 10)]);

    expect(reduceBanner(opened, outboxAt(2, 0, T0 + 20))).toBe(opened);
  });

  it('a tick before any deadline does not churn the state', () => {
    const opened = run([offlineAt('backend_unreachable', T0)]);

    expect(reduceBanner(opened, { type: 'tick', now: T0 + 1_000 })).toBe(opened);
  });
});

describe('nextTickDelayMs', () => {
  it('has nothing to schedule when nothing is on a clock', () => {
    expect(nextTickDelayMs(hidden, T0)).toBeNull();

    const serverDown = run([offlineAt('backend_unreachable', T0)]);
    expect(nextTickDelayMs(serverDown, T0)).toBeNull();

    const needsRetry = run([
      offlineAt('backend_unreachable', T0),
      outboxAt(1, 0, T0 + 10),
      onlineAt(T0 + 5_000),
      outboxAt(0, 1, T0 + 6_000),
    ]);
    expect(nextTickDelayMs(needsRetry, T0 + 6_000)).toBeNull();
  });

  it('schedules the "no signal" collapse', () => {
    const opened = run([offlineAt('device_offline', T0)]);

    expect(nextTickDelayMs(opened, T0 + 1_000)).toBe(BANNER_TIMING.DEVICE_OFFLINE_COLLAPSE_MS - 1_000);

    const collapsed = reduceBanner(opened, { type: 'dismiss' });
    expect(nextTickDelayMs(collapsed, T0 + 1_000)).toBeNull();
  });

  it('takes the nearest deadline when two are pending', () => {
    const state = run(
      [
        offlineAt('device_offline', T0),
        { type: 'retry_started' },
        { type: 'retry_result', backend: 'unreachable', now: T0 + 1_000 },
      ],
      hidden,
    );

    // Collapse is due at +8000, the still-down reset at +5000.
    expect(nextTickDelayMs(state, T0 + 1_000)).toBe(BANNER_TIMING.STILL_DOWN_MS);
  });

  it('schedules the recovery timeout and the synced auto-hide', () => {
    const recovering = run([offlineAt('device_offline', T0), outboxAt(4, 0, T0 + 10), onlineAt(T0 + 5_000)]);
    expect(nextTickDelayMs(recovering, T0 + 5_000)).toBe(BANNER_TIMING.RECOVERY_TIMEOUT_MS);

    const synced = run([offlineAt('backend_unreachable', T0), onlineAt(T0 + 5_000)]);
    expect(nextTickDelayMs(synced, T0 + 5_000)).toBe(BANNER_TIMING.SYNCED_HIDE_MS);
  });

  it('floors an overdue deadline at zero rather than returning a negative delay', () => {
    // The app was backgrounded straight through the deadline.
    const synced = run([offlineAt('backend_unreachable', T0), onlineAt(T0 + 5_000)]);

    expect(nextTickDelayMs(synced, T0 + 5_000 + BANNER_TIMING.SYNCED_HIDE_MS * 10)).toBe(0);
  });
});

describe('custom timing', () => {
  it('honours an injected timing table', () => {
    const fast = { ...BANNER_TIMING, DEVICE_OFFLINE_COLLAPSE_MS: 10 };
    const opened = run([offlineAt('device_offline', T0)]);

    expect(expectActive(reduceBanner(opened, { type: 'tick', now: T0 + 10 }, fast)).expanded).toBe(false);
    expect(nextTickDelayMs(opened, T0, fast)).toBe(10);
  });
});
