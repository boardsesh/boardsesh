// The session's shared rest clock (#5382): one cadence every crew member's rest
// timer follows, so the phone holding the board can advance the wall for the
// whole crew. This module is pure: the reducer, the stored-doc codec, the wire
// projection and a compare-and-set commit loop over an injected store. Redis
// and the in-memory fallback live in distributed-state/session-ops.ts and
// room-manager.ts.
//
// The state mirrors the mobile rest-timer store (packages/mobile/src/lib/
// rest-timer-store.ts) action for action, so a phone that adopts the crew clock
// behaves exactly as if it had run the same actions itself. Every instant is
// server epoch ms, stamped here from `nowMs` — clients never send a timestamp,
// only how long ago something happened (`elapsedMs`). A FIRE's beat comes from
// the stored anchor and interval, never from the phone (see
// claimableRestCadenceBeatMs).

import type {
  SessionRestCadence,
  SessionRestCadenceAction,
  SessionRestCadenceAnchor,
  SessionRestCadenceChanged,
} from '@boardsesh/shared-schema/generated';

export const REST_CADENCE_MODES = ['afterTick', 'onTheMinute'] as const;
export type RestCadenceMode = (typeof REST_CADENCE_MODES)[number];

/** deadline: advance when the rest runs out. tick / send: only after a tick (send: a flash or send) on the current climb. */
export const REST_CADENCE_ADVANCE_RULES = ['deadline', 'tick', 'send'] as const;
export type RestCadenceAdvanceRule = (typeof REST_CADENCE_ADVANCE_RULES)[number];

export const REST_CADENCE_SOURCES = ['settings', 'stage'] as const;
export type RestCadenceSource = (typeof REST_CADENCE_SOURCES)[number];

export const REST_CADENCE_TICK_STATUSES = ['flash', 'send', 'attempt'] as const;
export type RestCadenceTickStatus = (typeof REST_CADENCE_TICK_STATUSES)[number];

/**
 * Rest length bounds per mode. afterTick allows 10 s because a workout stage
 * with "no rest" still needs a changeover clear of the client's 5 s overdue
 * grace (STAGE_CHANGEOVER_SECONDS in @boardsesh/playlist-generator). The
 * settings sheet never goes below 15 s, which is also the shortest beat
 * onTheMinute accepts.
 */
export const REST_CADENCE_TARGET_SECONDS: Readonly<Record<RestCadenceMode, { min: number; max: number }>> = {
  afterTick: { min: 10, max: 3600 },
  onTheMinute: { min: 15, max: 3600 },
};

/** Upper bound for any client-reported elapsed: the session-membership TTL (4 h). */
export const MAX_REST_CADENCE_ELAPSED_MS = 4 * 60 * 60 * 1000;
export const MAX_REST_CADENCE_PAUSED_SECONDS = MAX_REST_CADENCE_ELAPSED_MS / 1000;

/**
 * The oldest a TICK may be and still count as a climb just done. A TICK's
 * `elapsedMs` is the time since the climber logged it, from its own climbedAt;
 * one older than this is history (yesterday's session logged with the date
 * picker, a save that sat in an offline queue) and never earns an advance
 * (isHistoricalRestCadenceTick). Exactly a minute is still fresh. It is the
 * phone's AUTO_ADVANCE_MAX_BACKDATE_MS (`isTickFreshEnoughToArm` in mobile's
 * rest-timer-auto-advance.ts), with the same boundary. The name is from when
 * every TICK was clamped to it; a fresh tick is inside it, so nothing is
 * clamped any more.
 */
export const REST_CADENCE_LATE_CLAMP_MS = 60_000;

/**
 * How early a FIRE may claim a beat: a beat counts as due once the server's
 * clock reaches the beat minus this. It covers the error in a phone's estimate
 * of the server clock (calibrated on a round-trip midpoint), so the holder's
 * FIRE for the beat it just watched fall due is not refused as early. It is a
 * fifth of the shortest interval (10 s), so no FIRE can reach a beat ahead.
 */
export const REST_CADENCE_FIRE_EARLY_TOLERANCE_MS = 2_000;

/**
 * How late a FIRE may claim a beat: a beat more than this far behind the
 * server's clock is never claimed. It mirrors the phone's overdue grace
 * (AUTO_ADVANCE_OVERDUE_GRACE_MS in mobile's rest-timer-auto-advance.ts): a
 * beat that far gone fell due while nobody was watching (a backgrounded
 * holder, a RESUME or ARM whose elapsed is past a beat), and moving the wall
 * for it now would surprise the crew. It must stay below the shortest
 * onTheMinute interval minus the early tolerance (15 s − 2 s = 13 s);
 * otherwise a late claim of one beat and an early claim of the next could land
 * a moment apart. At 5 s, two FIREs that both apply are at least 8 s apart.
 * An afterTick deadline that goes stale stays stale until a TICK, a RESET or a
 * CONFIGURE with anchor NOW re-anchors the clock; onTheMinute recovers on its
 * next beat.
 */
export const REST_CADENCE_FIRE_LATE_TOLERANCE_MS = 5_000;

/**
 * Older than any rest the clock can hold: the longest rest in either mode
 * (1 h) plus REST_CADENCE_FIRE_LATE_TOLERANCE_MS. A historical TICK this old
 * belongs to no rest, so it never starts one on a clock that has none running
 * (historicalTickChangesNothing). It is a fixed number, never the stored
 * length, because a later CONFIGURE can change the length.
 */
export const REST_CADENCE_OLDER_THAN_ANY_REST_MS =
  Math.max(REST_CADENCE_TARGET_SECONDS.afterTick.max, REST_CADENCE_TARGET_SECONDS.onTheMinute.max) * 1000 +
  REST_CADENCE_FIRE_LATE_TOLERANCE_MS;

/**
 * How much closer than one interval an afterTick deadline may sit to the last
 * one claimed (lastFiredBeatMs) and still be claimed. Every anchor the clock
 * reaches by its normal moves sits at most this far before the last advance:
 * a FIRE re-anchors at the later of now and its beat; a fresh TICK floors at
 * the beat; a RESET or a CONFIGURE anchor NOW with elapsedMs 0 lands at now,
 * at most the early tolerance (2 s) before a beat an early FIRE claimed; and
 * RESUME moves the fired beat with the anchor, off by under a second (PAUSE
 * freezes whole seconds). So the next deadline is at least one interval minus
 * this after the last. A closer one can only come from a CONFIGURE that
 * reaches back (anchor NOW with an elapsedMs past the last advance, or KEEP
 * onto an anchor from before it), and claiming it would move the wall twice
 * inside one rest. FIRE refuses it; that deadline then goes stale like a
 * missed one.
 */
export const REST_CADENCE_AFTER_TICK_SPACING_SLACK_MS = REST_CADENCE_FIRE_EARLY_TOLERANCE_MS + 1_000;

/** Internal retries for an un-fenced write that lost a compare-and-set race. */
export const REST_CADENCE_CAS_ATTEMPTS = 5;

/** Revisions count from here (2026-01-01 UTC). See restCadenceRevisionFloor. */
export const REST_CADENCE_REVISION_EPOCH_MS = Date.UTC(2026, 0, 1);

/**
 * The lowest revision a write at `nowMs` may take: whole seconds since
 * REST_CADENCE_REVISION_EPOCH_MS. Every store writes max(stored + 1, this), so
 * the revision keeps climbing even when the store loses the hash (Redis
 * restarting from an older snapshot, a failover to a lagging replica, an
 * expired key). Without it, every phone holding a higher revision would drop
 * each change until it resubscribed. A phone can only hold a revision ahead of
 * this clock by the writes beyond one a second it has seen, which a reset
 * outlasts; `rewound` in commitRestCadenceAction covers a FIRE that still lands
 * in that gap. Whole seconds since 2026 fit GraphQL's 32-bit Int until 2094.
 */
export function restCadenceRevisionFloor(nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - REST_CADENCE_REVISION_EPOCH_MS) / 1000));
}

export type RestCadenceConfig = {
  mode: RestCadenceMode;
  /** null = Off: the timer counts up and never fires. */
  targetSeconds: number | null;
  autoAdvance: boolean;
  advanceOn: RestCadenceAdvanceRule;
  source: RestCadenceSource;
};

export type RestCadenceLastTick = {
  queueItemUuid: string | null;
  status: RestCadenceTickStatus;
};

export type RestCadenceState = RestCadenceConfig & {
  isRunning: boolean;
  /** What the current cycle counts from; null = waiting for a tick. */
  anchorMs: number | null;
  /** Frozen elapsed while paused; 0 while running. */
  pausedElapsedSeconds: number;
  /** The beat the last auto-advance fired on, so no beat fires twice. */
  lastFiredBeatMs: number | null;
  /** Cleared by an advance under tick/send, so the next climb needs its own tick. */
  lastTick: RestCadenceLastTick | null;
  /** ctx.participantId verbatim of whoever last armed or configured the clock. */
  setByParticipantId: string | null;
};

/** What the store holds: a per-session revision (0 = never set) and the clock (null = off). */
export type StoredRestCadence = { revision: number; cadence: RestCadenceState | null };

/** A validated `SessionRestCadenceInput` (see SessionRestCadenceInputSchema). */
export type RestCadenceInput = {
  action: SessionRestCadenceAction;
  config?: RestCadenceConfig | null;
  elapsedMs?: number | null;
  anchor?: SessionRestCadenceAnchor | null;
  isRunning?: boolean | null;
  pausedElapsedSeconds?: number | null;
  tickQueueItemUuid?: string | null;
  tickStatus?: RestCadenceTickStatus | null;
  /** Accepted on the wire and ignored: a FIRE's beat comes from the stored clock (claimableRestCadenceBeatMs). */
  firedBeatAgoMs?: number | null;
  expectedRevision?: number | null;
};

export type RestCadenceReduction = { applicable: false } | { applicable: true; next: RestCadenceState | null };

const NOT_APPLICABLE: RestCadenceReduction = { applicable: false };

function clampMs(value: number | null | undefined, maxMs: number): number {
  return Math.min(maxMs, Math.max(0, value ?? 0));
}

function pickConfig(config: RestCadenceConfig): RestCadenceConfig {
  return {
    mode: config.mode,
    targetSeconds: config.targetSeconds,
    autoAdvance: config.autoAdvance,
    advanceOn: config.advanceOn,
    source: config.source,
  };
}

/**
 * Where the anchor goes after an auto-advance. afterTick + deadline restarts
 * the rest from the advance; onTheMinute holds its beat; afterTick + tick/send
 * waits for a tick on the next climb, so the wall never walks on with nobody
 * climbing. The phone follows the same rule (`anchorAfterFire`, workouts
 * contracts §4).
 */
function anchorAfterFire(state: RestCadenceState): 'now' | 'keep' | 'clear' {
  if (state.mode === 'afterTick' && state.advanceOn === 'deadline') return 'now';
  if (state.mode === 'onTheMinute') return 'keep';
  return 'clear';
}

/**
 * Whether the stored clock holds the tick its advance rule needs. The phone
 * that fires also checks the tick was on the current climb
 * (`restAdvanceAllowed`, workouts contracts §4); the server cannot see the
 * queue, so it checks the part it can: under tick there is a tick, under send
 * it was a flash or send.
 */
function hasQualifyingTick(state: RestCadenceState): boolean {
  if (state.advanceOn === 'deadline') return true;
  if (!state.lastTick) return false;
  return state.advanceOn === 'tick' || state.lastTick.status !== 'attempt';
}

/**
 * The beat a FIRE at server time `nowMs` claims, worked out from the stored
 * anchor and interval alone, never from anything the phone reports. afterTick
 * has one deadline per cycle, anchor + interval. onTheMinute takes the latest
 * beat on its grid that is due, anchor + k × interval with k ≥ 1 (the anchor
 * itself is not a beat, as on the phone). The beat B is claimable only while
 * B − REST_CADENCE_FIRE_EARLY_TOLERANCE_MS ≤ nowMs ≤ B +
 * REST_CADENCE_FIRE_LATE_TOLERANCE_MS; null means nothing is claimable: no
 * beat is due yet, or the latest one is too far gone.
 *
 * Deriving the beat here is what makes "once per beat" hold: every FIRE inside
 * one beat's window resolves to the same instant whatever beat age it
 * reports, so the second fails the `> lastFiredBeatMs` check in the reducer.
 * The two bounds keep the windows of neighbouring beats at least
 * interval − 7 s apart, so a late claim of one beat can never sit a moment
 * before an early claim of the next.
 */
export function claimableRestCadenceBeatMs(state: RestCadenceState, nowMs: number): number | null {
  if (state.anchorMs === null || state.targetSeconds === null || state.targetSeconds <= 0) return null;
  const intervalMs = state.targetSeconds * 1000;
  const dueByMs = nowMs + REST_CADENCE_FIRE_EARLY_TOLERANCE_MS;
  let beatMs: number;
  if (state.mode === 'afterTick') {
    beatMs = state.anchorMs + intervalMs;
    if (beatMs > dueByMs) return null;
  } else {
    const beatsDue = Math.floor((dueByMs - state.anchorMs) / intervalMs);
    if (beatsDue < 1) return null;
    beatMs = state.anchorMs + beatsDue * intervalMs;
  }
  return nowMs - beatMs > REST_CADENCE_FIRE_LATE_TOLERANCE_MS ? null : beatMs;
}

/**
 * Whether a TICK is history: logged more than REST_CADENCE_LATE_CLAMP_MS
 * before it reached the server, judged on its own `elapsedMs`. The phone
 * judges its own ticks the same way (`isTickFreshEnoughToArm`). A missing
 * elapsed means the tick is from now.
 */
export function isHistoricalRestCadenceTick(elapsedMs: number | null | undefined): boolean {
  return (elapsedMs ?? 0) > REST_CADENCE_LATE_CLAMP_MS;
}

/**
 * Where a TICK at server time `nowMs` starts the rest: `elapsedMs` before now
 * (bounded by MAX_REST_CADENCE_ELAPSED_MS, which the wire enforces too), but
 * never earlier than the rest already running (the stored anchor) or the last
 * advance (lastFiredBeatMs), and never in the future. So a backdated tick,
 * such as a crewmate's tick on the previous climb that reached the server
 * late, can no longer shorten a running rest or start one before the wall
 * last moved. Without the floor, a tick dated 55 s back that landed 2 s after
 * an advance on a 60 s rest fired the next advance 7 s later.
 *
 * The cap at now matters because both floors can sit ahead of the server
 * clock: an early FIRE anchors on a beat up to the early tolerance (2 s)
 * ahead, and RESUME can shift the fired beat about a second further (PAUSE
 * freezes whole seconds). The first tick of a session, with no anchor and
 * nothing fired, anchors where it always did.
 *
 * A historical tick that changes the clock at all (historicalTickChangesNothing
 * says when it does not) takes this floor too, so every anchor a TICK writes
 * sits at or after the last advance, whatever a later CONFIGURE does to the
 * length or the mode. On a running rest it never rewinds that rest; a tick
 * newer than a stale anchor can still move it forward, never before the last
 * advance.
 */
function restCadenceTickAnchorMs(
  previous: Pick<RestCadenceState, 'anchorMs' | 'lastFiredBeatMs'>,
  elapsedMs: number | null | undefined,
  nowMs: number,
): number {
  const tickMs = nowMs - clampMs(elapsedMs, MAX_REST_CADENCE_ELAPSED_MS);
  return Math.min(nowMs, Math.max(tickMs, previous.anchorMs ?? tickMs, previous.lastFiredBeatMs ?? tickMs));
}

/**
 * Whether an afterTick deadline sits closer to the last claimed one than a
 * full interval minus REST_CADENCE_AFTER_TICK_SPACING_SLACK_MS: a deadline
 * only a CONFIGURE reaching back can produce. A defence in depth behind the
 * TICK floor, so no sequence of actions moves the wall twice inside one rest.
 */
function tooSoonAfterLastAfterTickBeat(
  previous: Pick<RestCadenceState, 'lastFiredBeatMs' | 'targetSeconds'>,
  beatMs: number,
): boolean {
  if (previous.lastFiredBeatMs === null || previous.targetSeconds === null) return false;
  const intervalMs = previous.targetSeconds * 1000;
  return beatMs < previous.lastFiredBeatMs + intervalMs - REST_CADENCE_AFTER_TICK_SPACING_SLACK_MS;
}

/**
 * Whether a historical TICK leaves the clock exactly as it is: it keeps the
 * last tick either way (restCadenceLastTickAfter), so here it also writes no
 * anchor and changes no running state.
 *
 * - afterTick, paused: the pause and the rest it froze stand, as on the phone
 *   (noteRestTimerTick keeps a paused timer paused for a historical tick).
 *   Resuming would count up from yesterday.
 * - No rest running (no anchor: waiting for a tick) and older than any rest
 *   (REST_CADENCE_OLDER_THAN_ANY_REST_MS): the clock keeps waiting. The phone
 *   anchors such a tick at its own time, where its deadline is long gone.
 *   The server does not, because a stale anchor before the last advance comes
 *   back to life under a later CONFIGURE: KEEP onto a longer rest puts its
 *   deadline seconds after the last advance, and KEEP onto onTheMinute (a
 *   stage change to the same interval) puts a grid beat there. Waiting, it
 *   has nothing to revive.
 *
 * Every other historical tick goes through the floor: one on a running rest
 * (it never rewinds that rest), and one on a waiting clock that is no older
 * than the longest rest, which starts its rest no earlier than the last
 * advance. Floored, neither can authorize anything or bring a beat closer
 * than the last advance allows.
 */
function historicalTickChangesNothing(
  previous: Pick<RestCadenceState, 'mode' | 'isRunning' | 'anchorMs'>,
  elapsedMs: number | null | undefined,
): boolean {
  if (!isHistoricalRestCadenceTick(elapsedMs)) return false;
  if (previous.mode === 'afterTick' && !previous.isRunning) return true;
  return previous.anchorMs === null && (elapsedMs ?? 0) > REST_CADENCE_OLDER_THAN_ANY_REST_MS;
}

/**
 * The last tick after a TICK lands. A historical tick keeps the last one, so
 * it never authorizes a FIRE under tick or send. A tick naming no queue item
 * keeps it too, as the phone's `lastTickAfter` does: the phone names none when
 * the tick was on another climb or at another angle than the one lit
 * (`attributeTickToQueueItem`), so it can neither earn an advance nor take the
 * place of a tick that did.
 *
 * The phone also keeps a tick on the climb on the wall when a late one names
 * another queue item. The server cannot see which climb is on the wall, so a
 * fresh tick naming a queue item always replaces the last one; the holder's
 * own check (`restAdvanceAllowed`, the last tick must be on the current climb)
 * still refuses to fire on a tick from another climb.
 */
function restCadenceLastTickAfter(
  previous: Pick<RestCadenceState, 'lastTick'>,
  input: RestCadenceInput,
  status: RestCadenceTickStatus,
): RestCadenceLastTick | null {
  const queueItemUuid = input.tickQueueItemUuid ?? null;
  if (isHistoricalRestCadenceTick(input.elapsedMs) || queueItemUuid === null) return previous.lastTick;
  return { queueItemUuid, status };
}

/**
 * Apply one action to the stored clock. `applicable: false` means the action
 * does nothing to this state (no clock to change, PAUSE on a paused clock, a
 * FIRE on a clock that cannot fire) and nothing is written.
 */
export function applyRestCadenceAction(
  previous: RestCadenceState | null,
  input: RestCadenceInput,
  nowMs: number,
  participantId: string,
): RestCadenceReduction {
  if (input.action === 'ARM') {
    if (!input.config) return NOT_APPLICABLE;
    return {
      applicable: true,
      next: {
        ...pickConfig(input.config),
        isRunning: true,
        anchorMs: input.elapsedMs == null ? null : nowMs - clampMs(input.elapsedMs, MAX_REST_CADENCE_ELAPSED_MS),
        pausedElapsedSeconds: 0,
        lastFiredBeatMs: null,
        lastTick: null,
        setByParticipantId: participantId,
      },
    };
  }

  if (!previous) return NOT_APPLICABLE;

  switch (input.action) {
    case 'DISARM':
      return { applicable: true, next: null };

    case 'CONFIGURE': {
      if (!input.config) return NOT_APPLICABLE;
      const anchor = input.anchor ?? 'KEEP';
      const reanchored =
        anchor === 'NOW'
          ? { anchorMs: nowMs - clampMs(input.elapsedMs, MAX_REST_CADENCE_ELAPSED_MS), pausedElapsedSeconds: 0 }
          : anchor === 'CLEAR'
            ? { anchorMs: null }
            : {};
      return {
        applicable: true,
        next: { ...previous, ...pickConfig(input.config), ...reanchored, setByParticipantId: participantId },
      };
    }

    case 'TICK': {
      if (!input.tickStatus) return NOT_APPLICABLE;
      // Applicable but unchanged, so nothing is written or published.
      if (historicalTickChangesNothing(previous, input.elapsedMs)) return { applicable: true, next: previous };
      const lastTick = restCadenceLastTickAfter(previous, input, input.tickStatus);
      if (previous.mode === 'onTheMinute') {
        // Holding the beat is the whole mode: a tick only starts a clock that has no anchor yet.
        const anchorMs = previous.anchorMs ?? restCadenceTickAnchorMs(previous, input.elapsedMs, nowMs);
        return { applicable: true, next: { ...previous, lastTick, anchorMs } };
      }
      const tickAnchorMs = restCadenceTickAnchorMs(previous, input.elapsedMs, nowMs);
      return {
        applicable: true,
        next: { ...previous, lastTick, anchorMs: tickAnchorMs, isRunning: true, pausedElapsedSeconds: 0 },
      };
    }

    case 'FIRE': {
      // The compare-and-set on expectedRevision happens in the store; this
      // refuses a beat the stored clock could never have produced (so a buggy
      // phone can never walk the wall on a paused clock or without the tick)
      // and a beat that is not due yet, too far gone, or already claimed. The revision
      // alone cannot stop a second FIRE on one beat: a phone that adopted the
      // first FIRE's revision holds a valid one. lastFiredBeatMs lives in the
      // same revisioned doc, so the store's compare-and-set makes this check
      // atomic across instances.
      if (input.expectedRevision == null) return NOT_APPLICABLE;
      if (!previous.isRunning || !previous.autoAdvance || previous.targetSeconds === null) return NOT_APPLICABLE;
      if (previous.anchorMs === null || !hasQualifyingTick(previous)) return NOT_APPLICABLE;
      const beatMs = claimableRestCadenceBeatMs(previous, nowMs);
      if (beatMs === null) return NOT_APPLICABLE;
      if (previous.lastFiredBeatMs !== null && beatMs <= previous.lastFiredBeatMs) return NOT_APPLICABLE;
      if (previous.mode === 'afterTick' && tooSoonAfterLastAfterTickBeat(previous, beatMs)) return NOT_APPLICABLE;
      const fired = { ...previous, lastFiredBeatMs: beatMs };
      const anchor = anchorAfterFire(previous);
      if (anchor === 'now') {
        // A FIRE inside the early tolerance restarts the rest from the
        // deadline, not from the FIRE, so the next rest is a full interval.
        return { applicable: true, next: { ...fired, anchorMs: Math.max(nowMs, beatMs), pausedElapsedSeconds: 0 } };
      }
      if (anchor === 'keep') return { applicable: true, next: fired };
      return { applicable: true, next: { ...fired, anchorMs: null, lastTick: null } };
    }

    case 'PAUSE': {
      if (!previous.isRunning) return NOT_APPLICABLE;
      const pausedElapsedSeconds =
        input.pausedElapsedSeconds ??
        (previous.anchorMs === null
          ? previous.pausedElapsedSeconds
          : Math.max(0, Math.floor((nowMs - previous.anchorMs) / 1000)));
      return {
        applicable: true,
        next: {
          ...previous,
          isRunning: false,
          pausedElapsedSeconds: Math.min(pausedElapsedSeconds, MAX_REST_CADENCE_PAUSED_SECONDS),
        },
      };
    }

    case 'RESUME': {
      if (previous.isRunning) return NOT_APPLICABLE;
      const anchorMs = nowMs - previous.pausedElapsedSeconds * 1000;
      // The grid moves by however long the pause lasted, so the fired beat
      // moves with it: otherwise the beat fired just before a pause comes due
      // again just after it, under a later instant than lastFiredBeatMs.
      const lastFiredBeatMs =
        previous.lastFiredBeatMs === null || previous.anchorMs === null
          ? previous.lastFiredBeatMs
          : previous.lastFiredBeatMs + (anchorMs - previous.anchorMs);
      return {
        applicable: true,
        next: { ...previous, isRunning: true, anchorMs, pausedElapsedSeconds: 0, lastFiredBeatMs },
      };
    }

    case 'RESET': {
      // Back to zero. The last tick goes, so a tick from before the reset no
      // longer satisfies a tick/send advance. The fired beat stays, as on the
      // phone (resetRestTimer keeps lastFiredDeadlineMs): clearing it would let
      // a backdated TICK re-anchor onto a beat an early FIRE already claimed
      // and fire it again. Keeping it never refuses a real beat: a running
      // clock's first beat is a full interval (10 s or more) after the reset,
      // and every claimed beat is at most a few seconds past its FIRE (the
      // early tolerance, or RESUME's whole-second shift). A paused one waits
      // for a TICK, which the floor in restCadenceTickAnchorMs starts no
      // earlier than the fired beat.
      const isRunning = input.isRunning ?? previous.isRunning;
      return {
        applicable: true,
        next: {
          ...previous,
          isRunning,
          anchorMs: isRunning ? nowMs : null,
          pausedElapsedSeconds: 0,
          lastTick: null,
        },
      };
    }

    default: {
      const unhandled: never = input.action;
      throw new Error(`Unhandled rest cadence action: ${String(unhandled)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Stored doc codec: '' = off, otherwise the JSON of a RestCadenceState.
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(options: readonly T[], candidate: unknown): candidate is T {
  return typeof candidate === 'string' && (options as readonly string[]).includes(candidate);
}

function isNullableNumber(candidate: unknown): candidate is number | null {
  return candidate === null || (typeof candidate === 'number' && Number.isFinite(candidate));
}

function isNullableString(candidate: unknown): candidate is string | null {
  return candidate === null || typeof candidate === 'string';
}

function isLastTick(candidate: unknown): candidate is RestCadenceLastTick | null {
  if (candidate === null) return true;
  if (typeof candidate !== 'object') return false;
  const tick = candidate as Record<string, unknown>;
  return isNullableString(tick.queueItemUuid) && isOneOf(REST_CADENCE_TICK_STATUSES, tick.status);
}

export function isRestCadenceState(candidate: unknown): candidate is RestCadenceState {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const state = candidate as Record<string, unknown>;
  return (
    isOneOf(REST_CADENCE_MODES, state.mode) &&
    isNullableNumber(state.targetSeconds) &&
    typeof state.autoAdvance === 'boolean' &&
    isOneOf(REST_CADENCE_ADVANCE_RULES, state.advanceOn) &&
    isOneOf(REST_CADENCE_SOURCES, state.source) &&
    typeof state.isRunning === 'boolean' &&
    isNullableNumber(state.anchorMs) &&
    typeof state.pausedElapsedSeconds === 'number' &&
    Number.isFinite(state.pausedElapsedSeconds) &&
    isNullableNumber(state.lastFiredBeatMs) &&
    isLastTick(state.lastTick) &&
    isNullableString(state.setByParticipantId)
  );
}

export function serializeRestCadence(cadence: RestCadenceState | null): string {
  return cadence ? JSON.stringify(cadence) : '';
}

/** A doc that is empty or unreadable reads as "off", so the next ARM starts clean. */
export function parseRestCadence(doc: string | null | undefined): RestCadenceState | null {
  if (!doc) return null;
  try {
    const parsed: unknown = JSON.parse(doc);
    return isRestCadenceState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function sameRestCadence(left: RestCadenceState | null, right: RestCadenceState | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.mode === right.mode &&
    left.targetSeconds === right.targetSeconds &&
    left.autoAdvance === right.autoAdvance &&
    left.advanceOn === right.advanceOn &&
    left.source === right.source &&
    left.isRunning === right.isRunning &&
    left.anchorMs === right.anchorMs &&
    left.pausedElapsedSeconds === right.pausedElapsedSeconds &&
    left.lastFiredBeatMs === right.lastFiredBeatMs &&
    left.lastTick?.queueItemUuid === right.lastTick?.queueItemUuid &&
    left.lastTick?.status === right.lastTick?.status &&
    left.setByParticipantId === right.setByParticipantId
  );
}

// ---------------------------------------------------------------------------
// Wire projection
// ---------------------------------------------------------------------------

const msToWire = (ms: number | null): string | null => (ms === null ? null : String(ms));

export function toWireRestCadence(cadence: RestCadenceState | null): SessionRestCadence | null {
  if (!cadence) return null;
  return {
    __typename: 'SessionRestCadence',
    mode: cadence.mode,
    targetSeconds: cadence.targetSeconds,
    autoAdvance: cadence.autoAdvance,
    advanceOn: cadence.advanceOn,
    source: cadence.source,
    isRunning: cadence.isRunning,
    anchorAt: msToWire(cadence.anchorMs),
    pausedElapsedSeconds: cadence.pausedElapsedSeconds,
    lastFiredBeatAt: msToWire(cadence.lastFiredBeatMs),
    lastTickQueueItemUuid: cadence.lastTick?.queueItemUuid ?? null,
    lastTickStatus: cadence.lastTick?.status ?? null,
    setByParticipantId: cadence.setByParticipantId,
  };
}

export type RestCadenceChangedEvent = SessionRestCadenceChanged & { __typename: 'SessionRestCadenceChanged' };

export function buildRestCadenceChange(
  stored: StoredRestCadence,
  {
    isSnapshot,
    action,
    serverNowMs,
  }: { isSnapshot: boolean; action: SessionRestCadenceAction | null; serverNowMs: number },
): RestCadenceChangedEvent {
  return {
    __typename: 'SessionRestCadenceChanged',
    restCadence: toWireRestCadence(stored.cadence),
    revision: stored.revision,
    serverNow: String(serverNowMs),
    isSnapshot,
    action,
  };
}

// ---------------------------------------------------------------------------
// Compare-and-set commit over an injected store
// ---------------------------------------------------------------------------

export type RestCadenceCasResult = { ok: boolean; revision: number; doc: string };

export type RestCadenceStore = {
  read(): Promise<StoredRestCadence>;
  /**
   * Write `nextDoc` only if the stored revision still equals expectedRevision,
   * at max(expectedRevision + 1, minimumRevision).
   */
  compareAndSet(expectedRevision: number, nextDoc: string, minimumRevision: number): Promise<RestCadenceCasResult>;
};

export type RestCadenceCommit = {
  applied: boolean;
  stored: StoredRestCadence;
  /**
   * The caller sent an expectedRevision above the stored one. Only a store
   * that lost state can do that, so every phone may hold a revision the clock
   * no longer reaches: the caller sends `stored` as a snapshot, which resets
   * that floor.
   */
  rewound: boolean;
};

/**
 * Read → reduce → compare-and-set. A call that carries `expectedRevision` (FIRE
 * always does) is fenced: a stale revision, or losing the race, returns
 * `applied: false` with the state that won, and the caller must not act on it.
 * An un-fenced call (a TICK, a settings edit) re-reads and retries a lost race
 * up to REST_CADENCE_CAS_ATTEMPTS times, since its intent does not depend on the
 * state it first read. A reduction that changes nothing writes nothing.
 */
export async function commitRestCadenceAction(
  store: RestCadenceStore,
  input: RestCadenceInput,
  nowMs: number,
  participantId: string,
): Promise<RestCadenceCommit> {
  const expectedRevision = input.expectedRevision ?? null;
  const minimumRevision = restCadenceRevisionFloor(nowMs);
  const refused = (stored: StoredRestCadence): RestCadenceCommit => ({
    applied: false,
    stored,
    rewound: expectedRevision !== null && expectedRevision > stored.revision,
  });
  let current = await store.read();
  for (let attempt = 0; attempt < REST_CADENCE_CAS_ATTEMPTS; attempt++) {
    if (expectedRevision !== null && current.revision !== expectedRevision) return refused(current);
    const reduction = applyRestCadenceAction(current.cadence, input, nowMs, participantId);
    if (!reduction.applicable || sameRestCadence(reduction.next, current.cadence)) return refused(current);
    const result = await store.compareAndSet(current.revision, serializeRestCadence(reduction.next), minimumRevision);
    if (result.ok) {
      return { applied: true, rewound: false, stored: { revision: result.revision, cadence: reduction.next } };
    }
    current = { revision: result.revision, cadence: parseRestCadence(result.doc) };
    if (expectedRevision !== null) return refused(current);
  }
  return refused(current);
}
