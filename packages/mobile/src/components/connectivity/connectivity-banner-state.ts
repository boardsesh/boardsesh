// The connectivity banner's whole life cycle as a pure function (issue #4862).
//
// The banner is not a boolean. It opens on an outage, collapses itself when the
// reason is one the climber already knows about (their phone has no signal),
// morphs through "Back online. Syncing 3 changes…" into "All synced", and lands
// on "1 change needs a retry" when the drain gave up. Every one of those moves is
// timing-dependent, and timing-dependent UI written inline in a component is
// only testable by rendering it and waiting.
//
// So the decisions live here, with no React and no clock of their own: the host
// hook feeds `now` in with each event and schedules the next `tick` from
// {@link nextTickDelayMs}. Nothing in this file reads Date.now(), which is what
// makes the whole state machine table-testable.
//
// Analytics deliberately does NOT live here — the reducer stays pure, and the
// hook derives every event by comparing the state before and after.

import type { ConnectivityReason } from '../../lib/connectivity/connectivity-store';

export type BannerReason = ConnectivityReason;

/** Where a retry tap has got to. `stillDown` is a short-lived reassurance. */
export type BannerRetryPhase = 'idle' | 'inFlight' | 'stillDown';

export type BannerState =
  | { kind: 'hidden' }
  | {
      kind: 'active';
      reason: BannerReason;
      /** Start of THIS outage episode, from the connectivity store. */
      since: number;
      expanded: boolean;
      /**
       * When the card was last opened — episode start, or the tap that
       * re-expanded it. The auto-collapse window is measured from HERE, not from
       * `since`: `since` is the store's `unreachableSince`, which is already in
       * the past when the episode opens (and can be minutes old on a cold
       * start), so anchoring to it would collapse the card before it could be
       * read and would re-collapse it on the very next tick after a climber
       * deliberately reopened it.
       */
      expandedAt: number;
      retry: BannerRetryPhase;
      /** When the last retry came back down; drives the `stillDown` timeout. */
      retryAt: number | null;
      pendingCount: number;
      deadLetterCount: number;
      /** Retry taps this episode; the hook caps what it reports. */
      retryTaps: number;
    }
  | {
      kind: 'recovering';
      reasonBefore: BannerReason;
      /** Start of the outage this is recovering from, so the hook can time it. */
      since: number;
      recoveredAt: number;
      /** What was queued the instant the connection came back. */
      pendingAtRecovery: number;
      pendingCount: number;
      deadLetterAtRecovery: number;
      deadLetterCount: number;
    }
  | { kind: 'synced'; recoveredAt: number; settledAt: number; outcome: 'synced' | 'nothing_pending' }
  | { kind: 'needs_retry'; deadLettered: number; pendingCount: number };

export type BannerEvent =
  | { type: 'connectivity'; effectiveOffline: boolean; reason: BannerReason | null; since: number | null; now: number }
  | { type: 'outbox'; pendingCount: number; deadLetterCount: number; now: number }
  | { type: 'dismiss' }
  | { type: 'expand'; now: number }
  | { type: 'retry_started' }
  | { type: 'retry_result'; backend: 'reachable' | 'unreachable' | 'unknown'; now: number }
  | { type: 'tick'; now: number };

export const BANNER_TIMING = {
  /**
   * "No signal" is a state the climber can see in their own status bar, so the
   * full card is a reminder, not news — it shrinks to a pill after this. Server
   * trouble and offline mode do NOT auto-collapse: one is ours to explain, the
   * other is a setting they need a way back out of.
   */
  DEVICE_OFFLINE_COLLAPSE_MS: 8_000,
  /** How long "Still down" stays up before the retry button is offered again. */
  STILL_DOWN_MS: 4_000,
  /** "All synced" is an acknowledgement, not a status — it leaves on its own. */
  SYNCED_HIDE_MS: 2_500,
  /**
   * A drain that has not finished in a minute is not going to finish while the
   * climber watches a spinner. Give up on the banner rather than lie about
   * progress; the outbox keeps the writes and the next drain picks them up.
   */
  RECOVERY_TIMEOUT_MS: 60_000,
};

export type BannerTiming = typeof BANNER_TIMING;

const HIDDEN: BannerState = { kind: 'hidden' };

/** Counts carried into a new outage episode, so the card opens with a number. */
function carriedCounts(state: BannerState): { pendingCount: number; deadLetterCount: number } {
  switch (state.kind) {
    case 'active':
    case 'recovering':
      return { pendingCount: state.pendingCount, deadLetterCount: state.deadLetterCount };
    case 'needs_retry':
      return { pendingCount: state.pendingCount, deadLetterCount: state.deadLettered };
    default:
      return { pendingCount: 0, deadLetterCount: 0 };
  }
}

function startEpisode(state: BannerState, reason: BannerReason, since: number, now: number): BannerState {
  const { pendingCount, deadLetterCount } = carriedCounts(state);
  return {
    kind: 'active',
    reason,
    since,
    // Every episode opens explained. The climber has to be told what happened
    // once; the pill is what they live with afterwards.
    expanded: true,
    expandedAt: now,
    retry: 'idle',
    retryAt: null,
    pendingCount,
    deadLetterCount,
    retryTaps: 0,
  };
}

function reduceConnectivity(state: BannerState, event: Extract<BannerEvent, { type: 'connectivity' }>): BannerState {
  if (event.effectiveOffline) {
    // Offline with no reason is a store state we cannot render — it names no
    // copy and no icon. Hold whatever is on screen rather than reading it as
    // the back-online branch below, which would fake a recovery mid-outage.
    const reason = event.reason;
    if (reason === null) return state;
    // `since` comes from the connectivity store so two surfaces agree on when the
    // outage began; `now` is the fallback for a store that has not stamped it.
    const since = event.since ?? event.now;
    // Same reason, same start: the store re-published (a probe result, a
    // subscriber joining) without anything changing. Not a new episode — a
    // re-expand here would fight a climber who just collapsed the card.
    if (state.kind === 'active' && state.reason === reason && state.since === since) return state;
    return startEpisode(state, reason, since, event.now);
  }

  // Back online. Only an ACTIVE outage recovers — a `recovering` / `synced` /
  // `needs_retry` banner is already past this point, and re-entering recovery
  // from them would restart the drain animation on every online re-publish.
  if (state.kind !== 'active') return state;
  if (state.pendingCount === 0) {
    // Nothing was queued, so there is nothing to watch drain. Say so and go.
    return { kind: 'synced', recoveredAt: event.now, settledAt: event.now, outcome: 'nothing_pending' };
  }
  return {
    kind: 'recovering',
    reasonBefore: state.reason,
    since: state.since,
    recoveredAt: event.now,
    pendingAtRecovery: state.pendingCount,
    pendingCount: state.pendingCount,
    // Baseline, not a total: only dead letters produced by THIS drain are news.
    // A queue that already held one before the outage is a standing problem the
    // sync-issues screen owns, not something to blame on this reconnection.
    deadLetterAtRecovery: state.deadLetterCount,
    deadLetterCount: state.deadLetterCount,
  };
}

function reduceOutbox(state: BannerState, event: Extract<BannerEvent, { type: 'outbox' }>): BannerState {
  if (state.kind === 'active') {
    if (state.pendingCount === event.pendingCount && state.deadLetterCount === event.deadLetterCount) return state;
    return { ...state, pendingCount: event.pendingCount, deadLetterCount: event.deadLetterCount };
  }

  if (state.kind === 'needs_retry') {
    // The sync-issues screen is where these get retried or discarded, and either
    // way the outbox is what says so. Without this the banner would sit on a
    // problem the climber already fixed until they dismissed it by hand.
    if (event.deadLetterCount === 0) return HIDDEN;
    // `deadLettered` counts what THIS drain gave up on, so it may only shrink —
    // a dead letter arriving from somewhere else must not inflate the number the
    // banner attributes to the reconnection.
    const deadLettered = Math.min(state.deadLettered, event.deadLetterCount);
    if (deadLettered === state.deadLettered && event.pendingCount === state.pendingCount) return state;
    return { kind: 'needs_retry', deadLettered, pendingCount: event.pendingCount };
  }

  if (state.kind !== 'recovering') return state;

  if (event.pendingCount > 0) {
    if (state.pendingCount === event.pendingCount && state.deadLetterCount === event.deadLetterCount) return state;
    return { ...state, pendingCount: event.pendingCount, deadLetterCount: event.deadLetterCount };
  }

  // The queue is empty, so the drain is finished. Whether that is a success
  // depends on where the rows went: drained, or given up on.
  const newlyDeadLettered = event.deadLetterCount - state.deadLetterAtRecovery;
  if (newlyDeadLettered > 0) {
    return { kind: 'needs_retry', deadLettered: newlyDeadLettered, pendingCount: event.pendingCount };
  }
  return { kind: 'synced', recoveredAt: state.recoveredAt, settledAt: event.now, outcome: 'synced' };
}

function reduceTick(state: BannerState, now: number, timing: BannerTiming): BannerState {
  switch (state.kind) {
    case 'active': {
      const shouldCollapse =
        state.reason === 'device_offline' &&
        state.expanded &&
        now - state.expandedAt >= timing.DEVICE_OFFLINE_COLLAPSE_MS;
      const shouldClearStillDown =
        state.retry === 'stillDown' && state.retryAt !== null && now - state.retryAt >= timing.STILL_DOWN_MS;
      if (!shouldCollapse && !shouldClearStillDown) return state;
      return {
        ...state,
        expanded: shouldCollapse ? false : state.expanded,
        retry: shouldClearStillDown ? 'idle' : state.retry,
        retryAt: shouldClearStillDown ? null : state.retryAt,
      };
    }
    case 'recovering':
      return now - state.recoveredAt >= timing.RECOVERY_TIMEOUT_MS ? HIDDEN : state;
    case 'synced':
      return now - state.settledAt >= timing.SYNCED_HIDE_MS ? HIDDEN : state;
    default:
      return state;
  }
}

/**
 * The banner's only decision function. Pure: same state + event + timing always
 * gives the same result, and an unchanged outcome returns the SAME object so a
 * `useReducer` host does not re-render on a no-op event.
 */
export function reduceBanner(
  state: BannerState,
  event: BannerEvent,
  timing: BannerTiming = BANNER_TIMING,
): BannerState {
  switch (event.type) {
    case 'connectivity':
      return reduceConnectivity(state, event);

    case 'outbox':
      return reduceOutbox(state, event);

    case 'dismiss':
      // Dismiss can never hide a live outage. Sends are piling up on the phone
      // and the pill is the climber's only route back to the explanation — and,
      // in offline mode, their only route back online.
      if (state.kind === 'active') return state.expanded ? { ...state, expanded: false } : state;
      // Everything else is transient or already resolved, so "Hide" means hide.
      return state.kind === 'hidden' ? state : HIDDEN;

    case 'expand':
      if (state.kind !== 'active' || state.expanded) return state;
      // Restart the auto-collapse window: the climber just asked to read this,
      // so they get the full window rather than whatever is left of the
      // episode's original one.
      return { ...state, expanded: true, expandedAt: event.now };

    case 'retry_started':
      // A second tap on a probe already in flight is impatience, not a new
      // attempt — don't let it inflate the tap count either.
      if (state.kind !== 'active' || state.retry === 'inFlight') return state;
      return { ...state, retry: 'inFlight', retryAt: null, retryTaps: state.retryTaps + 1 };

    case 'retry_result':
      if (state.kind !== 'active') return state;
      // A reachable probe changes nothing here on purpose: the connectivity
      // store is the single source of "we are back", and it emits its own event.
      // Recovering from the probe result too would race it and could open the
      // recovery card off a reading the store then contradicts.
      if (event.backend === 'reachable') return state;
      // `unknown` (a probe that could not decide) is grouped with `unreachable`:
      // it is not evidence of recovery, and leaving the spinner running forever
      // would be the only other option.
      return { ...state, retry: 'stillDown', retryAt: event.now };

    case 'tick':
      return reduceTick(state, event.now, timing);
  }
}

/**
 * Milliseconds until this state's next self-driven change, or `null` when it has
 * none. The host hook schedules exactly one timer from this, so a state with no
 * pending deadline runs no timer at all.
 */
export function nextTickDelayMs(state: BannerState, now: number, timing: BannerTiming = BANNER_TIMING): number | null {
  const deadlines: number[] = [];
  switch (state.kind) {
    case 'active':
      if (state.reason === 'device_offline' && state.expanded) {
        deadlines.push(state.expandedAt + timing.DEVICE_OFFLINE_COLLAPSE_MS);
      }
      if (state.retry === 'stillDown' && state.retryAt !== null) {
        deadlines.push(state.retryAt + timing.STILL_DOWN_MS);
      }
      break;
    case 'recovering':
      deadlines.push(state.recoveredAt + timing.RECOVERY_TIMEOUT_MS);
      break;
    case 'synced':
      deadlines.push(state.settledAt + timing.SYNCED_HIDE_MS);
      break;
    default:
      break;
  }
  if (deadlines.length === 0) return null;
  // Floored at 0 rather than allowed negative: an overdue deadline (the app was
  // backgrounded through it) must fire on the next turn, not immediately in a
  // loop, and a negative setTimeout delay is a silent zero anyway.
  return Math.max(0, Math.min(...deadlines) - now);
}
