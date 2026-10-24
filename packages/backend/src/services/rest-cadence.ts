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
// only how long ago something happened (`elapsedMs`, `firedBeatAgoMs`).

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
 * How far back a TICK may re-anchor and a FIRE may date its beat. A tick that
 * waited longer in an offline queue anchors at most a minute in the past, so a
 * replayed tick can never fire an instant advance on a long-gone rest.
 */
export const REST_CADENCE_LATE_CLAMP_MS = 60_000;

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
 * climbing. Mirrors `anchorAfterFire` in mobile's rest-timer-pacing.ts.
 */
function anchorAfterFire(state: RestCadenceState): 'now' | 'keep' | 'clear' {
  if (state.mode === 'afterTick' && state.advanceOn === 'deadline') return 'now';
  if (state.mode === 'onTheMinute') return 'keep';
  return 'clear';
}

/**
 * Whether the stored clock holds the tick its advance rule needs. The phone
 * that fires checks the tick was on the current climb (`restAdvanceAllowed` in
 * mobile's rest-timer-pacing.ts); the server cannot see the queue, so it checks
 * the part it can: under tick there is a tick, under send it was a flash or send.
 */
function hasQualifyingTick(state: RestCadenceState): boolean {
  if (state.advanceOn === 'deadline') return true;
  if (!state.lastTick) return false;
  return state.advanceOn === 'tick' || state.lastTick.status !== 'attempt';
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
      const lastTick: RestCadenceLastTick = {
        queueItemUuid: input.tickQueueItemUuid ?? null,
        status: input.tickStatus,
      };
      const tickAnchorMs = nowMs - clampMs(input.elapsedMs, REST_CADENCE_LATE_CLAMP_MS);
      if (previous.mode === 'onTheMinute') {
        // Holding the beat is the whole mode: a tick only starts a clock that has no anchor yet.
        return { applicable: true, next: { ...previous, lastTick, anchorMs: previous.anchorMs ?? tickAnchorMs } };
      }
      return {
        applicable: true,
        next: { ...previous, lastTick, anchorMs: tickAnchorMs, isRunning: true, pausedElapsedSeconds: 0 },
      };
    }

    case 'FIRE': {
      // The compare-and-set on expectedRevision happens in the store; this only
      // refuses a beat the stored clock could never have produced, so a buggy
      // phone can never walk the wall on a paused clock or without the tick.
      if (input.expectedRevision == null) return NOT_APPLICABLE;
      if (!previous.isRunning || !previous.autoAdvance || previous.targetSeconds === null) return NOT_APPLICABLE;
      if (previous.anchorMs === null || !hasQualifyingTick(previous)) return NOT_APPLICABLE;
      const fired = {
        ...previous,
        lastFiredBeatMs: nowMs - clampMs(input.firedBeatAgoMs, REST_CADENCE_LATE_CLAMP_MS),
      };
      const anchor = anchorAfterFire(previous);
      if (anchor === 'now') return { applicable: true, next: { ...fired, anchorMs: nowMs, pausedElapsedSeconds: 0 } };
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

    case 'RESUME':
      if (previous.isRunning) return NOT_APPLICABLE;
      return {
        applicable: true,
        next: {
          ...previous,
          isRunning: true,
          anchorMs: nowMs - previous.pausedElapsedSeconds * 1000,
          pausedElapsedSeconds: 0,
        },
      };

    case 'RESET': {
      const isRunning = input.isRunning ?? previous.isRunning;
      return {
        applicable: true,
        next: { ...previous, isRunning, anchorMs: isRunning ? nowMs : null, pausedElapsedSeconds: 0 },
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
