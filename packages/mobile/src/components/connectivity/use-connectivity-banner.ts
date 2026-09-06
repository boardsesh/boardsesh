// Everything the connectivity banner needs, wired to the stores it reads and the
// clock it runs on (issue #4862). The decisions themselves live in the pure
// `connectivity-banner-state` reducer — this is the plumbing: three event feeds,
// one timer, and the analytics that can only be derived by comparing the state
// before a change with the state after it.

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { AppState } from 'react-native';
import { useRouter } from 'expo-router';
import { retryConnectivityNow, setOfflineMode } from '../../lib/connectivity/connectivity-store';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';
import { getDatabaseHandle } from '../../db';
import { useOfflineSchemaReady } from '../../db/use-offline-schema-ready';
import { notifyOutboxChanged, useOutboxSummary } from '../../offline/outbox-store';
import { useAuth } from '../../providers/auth-provider';
import {
  BANNER_TIMING,
  nextTickDelayMs,
  reduceBanner,
  type BannerEvent,
  type BannerReason,
  type BannerState,
} from './connectivity-banner-state';
import { trackBannerDismissed, trackBannerShown, trackRecovered, trackRetryTapped } from './connectivity-analytics';
import type { RecoveryOutcome } from './connectivity-analytics';

const INITIAL_STATE: BannerState = { kind: 'hidden' };

// `reduceBanner` takes an optional third argument (the timing table the tests
// inject); `useReducer` only ever passes two. Adapt it explicitly rather than
// relying on React's action-argument inference to tolerate the extra parameter.
function bannerReducer(state: BannerState, event: BannerEvent): BannerState {
  return reduceBanner(state, event);
}

// A scheduled tick must never fire BEFORE its deadline. Timers are allowed to
// run a hair early, and an early tick is a no-op the reducer returns unchanged —
// which leaves the state identical, so the scheduling effect never re-runs and
// the deadline is missed for good (the card stays expanded, "All synced" never
// leaves). One frame of slack costs nothing and removes the whole class.
const TICK_SAFETY_MS = 16;

export type ConnectivityBannerModel = {
  state: BannerState;
  /** Collapse the card to the pill; on a live outage it never hides. */
  dismiss: () => void;
  /** Reopen the card from the pill. */
  expand: () => void;
  /** Probe the backend now. Safe to call repeatedly — a probe in flight wins. */
  retry: () => void;
  /** Turn offline mode on from the banner (the "stop trying" answer). */
  stayOffline: () => void;
  /** Turn offline mode back off — the pill's only job in offline mode. */
  goOnline: () => void;
  /** Open the screen that owns changes we could not deliver. */
  openSyncIssues: () => void;
};

/** Which episode we have already reported a "shown" for. */
type ReportedEpisode = { reason: BannerReason; since: number };

function isSameEpisode(reported: ReportedEpisode | null, state: BannerState): boolean {
  if (reported === null || state.kind !== 'active') return false;
  return reported.reason === state.reason && reported.since === state.since;
}

/**
 * What a `recovering` state turning into `next` says about the drain. Split out
 * so the mapping is readable as a table rather than buried in an effect.
 */
function resolveRecoveryOutcome(next: BannerState, drainMs: number): RecoveryOutcome | null {
  switch (next.kind) {
    case 'synced':
      return 'synced';
    case 'needs_retry':
      return 'needs_retry';
    case 'active':
      // A second outage landed mid-drain. Not a failure — the queue is intact
      // and the next reconnection picks it up.
      return 'interrupted';
    case 'hidden':
      // Two ways out: the reducer's own give-up timer, or the climber hiding it.
      // Pooling them would inflate the timeout rate with deliberate dismissals.
      return drainMs >= BANNER_TIMING.RECOVERY_TIMEOUT_MS ? 'timeout' : 'dismissed';
    default:
      return null;
  }
}

export function useConnectivityBanner(): ConnectivityBannerModel {
  const [state, dispatch] = useReducer(bannerReducer, INITIAL_STATE);
  const connectivity = useConnectivity();
  const router = useRouter();
  const { isAuthenticated } = useAuth();
  // The SQLite handle is null until migrations land and goes null again on
  // sign-out, and neither is a React state change on its own — the readiness
  // store is what makes re-reading it a subscription rather than a guess.
  const schemaReady = useOfflineSchemaReady();
  const outbox = useOutboxSummary(schemaReady ? getDatabaseHandle() : null);

  // Actions read the CURRENT state without depending on it, so every callback
  // below stays referentially stable for the memoized banner rows. `send` keeps
  // this in lock-step with what the reducer will produce, so the assignment here
  // is a re-sync, never a correction.
  const stateRef = useRef(state);
  stateRef.current = state;
  const signedInRef = useRef(isAuthenticated);
  signedInRef.current = isAuthenticated;
  const reportedEpisodeRef = useRef<ReportedEpisode | null>(null);

  // Analytics that can only be seen from the OUTSIDE of the reducer: "shown" is
  // once per episode however the state churns inside it, and "recovered" needs
  // both the recovering state's numbers and where it ended up. Dismiss and retry
  // report from their own callbacks instead — a state diff cannot tell a tapped
  // dismiss from the auto-collapse.
  const reportTransition = useCallback((previous: BannerState, next: BannerState, now: number) => {
    if (next.kind === 'active' && !isSameEpisode(reportedEpisodeRef.current, next)) {
      reportedEpisodeRef.current = { reason: next.reason, since: next.since };
      trackBannerShown({ reason: next.reason, pendingCount: next.pendingCount, signedIn: signedInRef.current });
    }

    // The one recovery that never passes through `recovering`: nothing was
    // queued, so there was no drain to watch.
    if (previous.kind === 'active' && next.kind === 'synced' && next.outcome === 'nothing_pending') {
      trackRecovered({
        reasonBefore: previous.reason,
        episodeMs: next.recoveredAt - previous.since,
        pendingAtRecovery: 0,
        drainMs: 0,
        deadLettered: 0,
        outcome: 'nothing_pending',
      });
      return;
    }

    if (previous.kind !== 'recovering') return;
    const drainMs = now - previous.recoveredAt;
    const outcome = resolveRecoveryOutcome(next, drainMs);
    if (outcome === null) return;
    trackRecovered({
      reasonBefore: previous.reasonBefore,
      episodeMs: previous.recoveredAt - previous.since,
      pendingAtRecovery: previous.pendingAtRecovery,
      // A clean finish knows exactly when it settled; the other exits only know
      // when we stopped watching.
      drainMs: next.kind === 'synced' ? next.settledAt - previous.recoveredAt : drainMs,
      deadLettered: next.kind === 'needs_retry' ? next.deadLettered : 0,
      outcome,
    });
  }, []);

  /**
   * The only way an event reaches the reducer.
   *
   * It runs the reduction itself before dispatching so the analytics see EVERY
   * intermediate state. Diffing rendered states instead would miss a chain that
   * React batches into one commit — a reconnection whose connectivity and outbox
   * events land together goes active → recovering → synced in a single render,
   * and the `ConnectivityRecovered` event, which is the whole point of the
   * instrumentation, would never be emitted. The reducer stays pure; this only
   * calls it twice with the same inputs (React calls it again to produce the
   * commit), which is free and, in StrictMode, already the case.
   *
   * An event the reducer no-ops is not dispatched at all: React would bail out
   * anyway, and skipping it keeps a genuinely unchanged state from re-running
   * the scheduling effect.
   */
  const send = useCallback(
    (event: BannerEvent) => {
      const previous = stateRef.current;
      const next = reduceBanner(previous, event);
      if (next === previous) return;
      stateRef.current = next;
      reportTransition(previous, next, Date.now());
      dispatch(event);
    },
    [reportTransition],
  );

  const { effectiveOffline, reason, unreachableSince } = connectivity;
  // A drain can finish in the background (the queue drains on reconnect whether
  // or not anyone is looking), so the count held across a suspend can be minutes
  // stale. The outbox store owns no AppState listener of its own — a static
  // react-native import there would leak Flow source into the hooks barrel's
  // test graph — so the resume re-read is triggered from here.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') notifyOutboxChanged();
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    send({ type: 'connectivity', effectiveOffline, reason, since: unreachableSince, now: Date.now() });
  }, [send, effectiveOffline, reason, unreachableSince]);

  useEffect(() => {
    // `null` is "we could not read the outbox", which is not the same as "empty"
    // — reporting it as zero would let the banner claim everything is through.
    if (outbox === null) return;
    send({
      type: 'outbox',
      pendingCount: outbox.pendingCount,
      deadLetterCount: outbox.deadLetterCount,
      now: Date.now(),
    });
  }, [send, outbox]);

  // One timer, re-derived whenever the state changes. A state with no deadline
  // schedules nothing, so a hidden banner costs no timer at all.
  useEffect(() => {
    const delay = nextTickDelayMs(state, Date.now());
    if (delay === null) return;
    const handle = setTimeout(() => send({ type: 'tick', now: Date.now() }), delay + TICK_SAFETY_MS);
    return () => clearTimeout(handle);
  }, [send, state]);

  const dismiss = useCallback(() => {
    const current = stateRef.current;
    if (current.kind === 'active') {
      trackBannerDismissed({
        reason: current.reason,
        episodeMs: Date.now() - current.since,
        pendingCount: current.pendingCount,
      });
    }
    send({ type: 'dismiss' });
  }, [send]);

  const expand = useCallback(() => {
    send({ type: 'expand', now: Date.now() });
  }, [send]);

  const retry = useCallback(() => {
    const current = stateRef.current;
    // Mirror the reducer's own guard so an ignored tap fires no probe and no
    // event; otherwise a double-tap would report two attempts for one request.
    if (current.kind !== 'active' || current.retry === 'inFlight') return;
    const tapIndex = current.retryTaps + 1;
    const episodeSince = current.since;
    send({ type: 'retry_started' });

    const settle = (backend: 'reachable' | 'unreachable' | 'unknown') => {
      send({ type: 'retry_result', backend, now: Date.now() });
      trackRetryTapped({ outcome: backend, episodeMs: Date.now() - episodeSince, tapIndex });
    };
    // A rejected probe is indistinguishable from an inconclusive one from here,
    // and both must leave the button usable — never stuck spinning.
    void retryConnectivityNow().then(settle, () => settle('unknown'));
  }, [send]);

  const stayOffline = useCallback(() => {
    // The store owns the `OfflineModeToggled` event: it takes the source for
    // exactly that reason, and firing it here as well would double-count.
    setOfflineMode(true, 'banner');
  }, []);

  const goOnline = useCallback(() => {
    setOfflineMode(false, 'banner');
  }, []);

  const openSyncIssues = useCallback(() => {
    router.push('/(tabs)/profile/more');
  }, [router]);

  return useMemo(
    () => ({ state, dismiss, expand, retry, stayOffline, goOnline, openSyncIssues }),
    [state, dismiss, expand, retry, stayOffline, goOnline, openSyncIssues],
  );
}
