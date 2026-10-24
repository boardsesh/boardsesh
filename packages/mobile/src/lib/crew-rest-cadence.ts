// The crew's shared rest clock on this phone (#5382). The backend keeps one rest
// clock per session (packages/backend/src/services/rest-cadence.ts) and sends it
// to every member as `SessionRestCadenceChanged`. This module turns that wire
// shape into the rest-timer store's terms, decides which changes this phone
// takes, and builds the `setSessionRestCadence` inputs the publisher and the
// scheduler send. Pure functions plus two small pieces of module state: the
// revision floor and the last subscribe seed.
//
// The rules, from the workouts contracts (§10):
//   - A change at or below the revision this phone holds is dropped, unless it
//     is a snapshot (the subscribe seed, or a reply after the server lost
//     state), which replaces everything and resets the floor.
//   - An armed clock is taken only when this phone is already armed for that
//     session, or another member set it. So a cold start never quietly brings
//     back a clock this phone set in an earlier life, and an echo of this
//     phone's own ARM can never re-arm a timer it has since turned off.
//   - A mode or advance rule this app does not know makes the clock
//     unsupported: it is held (config null) so the scheduler never fires on it.
//   - Every instant is server epoch ms on the wire and is converted once, when
//     the change is taken, through the server clock offset (server-clock.ts).

import type {
  SessionRestCadenceAnchor,
  SessionRestCadenceConfigInput,
  SessionRestCadenceInput,
} from '@boardsesh/shared-schema/generated';
import type { RestTimerMode } from './rest-timer';
import type { CrewRestConfig, RestAdvanceRule, RestTimerLastTick } from './rest-timer-pacing';
import type { SessionRestCadenceChangeWire, SessionRestCadenceWire } from './graphql/operations';
import { adoptCrewCadence, clearCrewCadence, getRestTimerState, type RestTimerState } from './rest-timer-store';
import { noteServerTimeFromEvent, noteServerTimeFromMutation, serverToLocalMs, localToServerMs } from './server-clock';

/**
 * The crew clock as the rest-timer store holds it: the server's state with
 * every instant on this phone's clock. The server's own two instants are kept
 * too, so a later change can tell whether the server moved them (a converted
 * value also moves when the offset estimate does).
 */
export type CrewRestCadence = {
  sessionId: string;
  revision: number;
  /** Null when the clock uses a mode or advance rule this app does not know: never fire on it. */
  config: CrewRestConfig | null;
  isRunning: boolean;
  anchorMs: number | null;
  pausedElapsedSeconds: number;
  lastFiredBeatMs: number | null;
  lastTick: RestTimerLastTick | null;
  anchorServerMs: number | null;
  lastFiredBeatServerMs: number | null;
};

const MODES: readonly RestTimerMode[] = ['afterTick', 'onTheMinute'];
const ADVANCE_RULES: readonly RestAdvanceRule[] = ['deadline', 'tick', 'send'];
const SOURCES: readonly CrewRestConfig['source'][] = ['settings', 'stage'];
const TICK_STATUSES: readonly RestTimerLastTick['status'][] = ['flash', 'send', 'attempt'];

/** The server's rest length bounds per mode (REST_CADENCE_TARGET_SECONDS in the backend). */
export const CREW_REST_TARGET_SECONDS: Readonly<Record<RestTimerMode, { min: number; max: number }>> = {
  afterTick: { min: 10, max: 3600 },
  onTheMinute: { min: 15, max: 3600 },
};

/** The server refuses an elapsed above its session TTL (4 h). */
const MAX_ELAPSED_MS = 4 * 60 * 60 * 1000;

/** How long the holder waits for a FIRE reply before it gives the beat up (contracts §10). */
export const CREW_FIRE_TIMEOUT_MS = 2_000;
/** A FIRE claims a beat from 2 s before it (REST_CADENCE_FIRE_EARLY_TOLERANCE_MS). */
export const CREW_FIRE_EARLY_TOLERANCE_MS = 2_000;
/** ...until 5 s after it (REST_CADENCE_FIRE_LATE_TOLERANCE_MS, the phone's overdue grace). */
export const CREW_FIRE_LATE_TOLERANCE_MS = 5_000;
/** Retries of one beat after a refusal that might still land (not due yet, or a race). */
export const MAX_CREW_FIRE_RETRIES = 2;

function isOneOf<T extends string>(options: readonly T[], candidate: unknown): candidate is T {
  return typeof candidate === 'string' && (options as readonly string[]).includes(candidate);
}

function parseServerMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCrewConfig(wire: SessionRestCadenceWire): CrewRestConfig | null {
  if (!isOneOf(MODES, wire.mode) || !isOneOf(ADVANCE_RULES, wire.advanceOn) || !isOneOf(SOURCES, wire.source)) {
    return null;
  }
  const targetSeconds =
    typeof wire.targetSeconds === 'number' && Number.isFinite(wire.targetSeconds) ? wire.targetSeconds : null;
  return {
    mode: wire.mode,
    targetSeconds,
    autoAdvance: wire.autoAdvance === true,
    advanceOn: wire.advanceOn,
    source: wire.source,
    setByParticipantId: wire.setByParticipantId ?? null,
  };
}

/** The wire clock in the store's terms, converted with the offset as it stands now. */
export function parseCrewRestCadence(
  sessionId: string,
  revision: number,
  wire: SessionRestCadenceWire,
): CrewRestCadence {
  const anchorServerMs = parseServerMs(wire.anchorAt);
  const lastFiredBeatServerMs = parseServerMs(wire.lastFiredBeatAt);
  const lastTick: RestTimerLastTick | null = isOneOf(TICK_STATUSES, wire.lastTickStatus)
    ? { status: wire.lastTickStatus, queueItemUuid: wire.lastTickQueueItemUuid ?? null }
    : null;
  return {
    sessionId,
    revision,
    config: parseCrewConfig(wire),
    isRunning: wire.isRunning === true,
    anchorMs: anchorServerMs === null ? null : serverToLocalMs(anchorServerMs),
    pausedElapsedSeconds: Math.max(0, wire.pausedElapsedSeconds ?? 0),
    lastFiredBeatMs: lastFiredBeatServerMs === null ? null : serverToLocalMs(lastFiredBeatServerMs),
    lastTick,
    anchorServerMs,
    lastFiredBeatServerMs,
  };
}

/** The five fields an ARM or CONFIGURE carries. */
export type CrewConfigFields = Pick<CrewRestConfig, 'mode' | 'targetSeconds' | 'autoAdvance' | 'advanceOn' | 'source'>;

/** Field by field, so a freshly built config compares equal to the one held. */
export function sameCrewConfig(left: CrewConfigFields | null, right: CrewConfigFields | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.mode === right.mode &&
    left.targetSeconds === right.targetSeconds &&
    left.autoAdvance === right.autoAdvance &&
    left.advanceOn === right.advanceOn &&
    left.source === right.source
  );
}

// ---------------------------------------------------------------------------
// Taking a change: the revision floor, the adoption rule, the seed
// ---------------------------------------------------------------------------

let revisionFloor: { sessionId: string; revision: number } | null = null;

export type CrewCadenceSnapshot = { sessionId: string; hasClock: boolean };
let lastSnapshot: CrewCadenceSnapshot | null = null;
const snapshotListeners = new Set<(snapshot: CrewCadenceSnapshot) => void>();

/**
 * What became of a change:
 *   adopted      the store now follows it
 *   cleared      the crew turned the clock off, so this phone's timer is off too
 *   unsupported  held, but never fired on (a mode or rule this app lacks)
 *   ignored      armed clock this phone may not take (see the adoption rule)
 *   stale        at or below the revision already held
 */
export type CrewCadenceOutcome = 'adopted' | 'cleared' | 'unsupported' | 'ignored' | 'stale';

export type CrewCadenceChangeContext = {
  sessionId: string;
  /** This phone's participant id in the session, when known. */
  ownParticipantId: string | null;
  receivedAtMs: number;
  /** Set for a mutation reply: when the request went out, for the round-trip clock sample. */
  sentAtMs?: number;
};

function armedFor(state: RestTimerState, sessionId: string): boolean {
  return state.armed && state.armedForSessionId === sessionId;
}

/**
 * Take one `SessionRestCadenceChanged`, from the subscription or a mutation
 * reply. Notes the server clock, applies the revision floor and the adoption
 * rule, and writes the store.
 */
export function handleCrewCadenceChange(
  change: SessionRestCadenceChangeWire,
  { sessionId, ownParticipantId, receivedAtMs, sentAtMs }: CrewCadenceChangeContext,
): CrewCadenceOutcome {
  const serverNowMs = Number(change.serverNow);
  if (sentAtMs === undefined) noteServerTimeFromEvent({ serverNowMs, receivedAtMs });
  else noteServerTimeFromMutation({ serverNowMs, sentAtMs, receivedAtMs });

  if (revisionFloor?.sessionId !== sessionId) revisionFloor = null;
  if (!change.isSnapshot && revisionFloor !== null && change.revision <= revisionFloor.revision) return 'stale';
  revisionFloor = { sessionId, revision: change.revision };

  const outcome = applyCrewCadence(change, sessionId, ownParticipantId);
  if (change.isSnapshot) {
    lastSnapshot = { sessionId, hasClock: change.restCadence != null };
    for (const listener of snapshotListeners) listener(lastSnapshot);
  }
  return outcome;
}

function applyCrewCadence(
  change: SessionRestCadenceChangeWire,
  sessionId: string,
  ownParticipantId: string | null,
): CrewCadenceOutcome {
  const state = getRestTimerState();
  const wire = change.restCadence ?? null;
  if (wire === null) {
    // Only a clock this phone was following goes: a timer armed here whose ARM
    // has not reached the server yet is not the clock someone turned off.
    if (state.crew?.sessionId !== sessionId) return 'ignored';
    clearCrewCadence();
    return 'cleared';
  }
  const setBy = wire.setByParticipantId ?? null;
  const setByAnotherMember = setBy !== null && ownParticipantId !== null && setBy !== ownParticipantId;
  if (!armedFor(state, sessionId) && !setByAnotherMember) return 'ignored';
  const crew = parseCrewRestCadence(sessionId, change.revision, wire);
  adoptCrewCadence(crew, { replaceLocal: change.isSnapshot });
  return crew.config === null ? 'unsupported' : 'adopted';
}

/** The last subscribe seed seen, so a publisher that mounts after it still knows. */
export function getLastCrewCadenceSnapshot(): CrewCadenceSnapshot | null {
  return lastSnapshot;
}

/** Called on every subscribe seed this phone takes. */
export function subscribeCrewCadenceSnapshots(listener: (snapshot: CrewCadenceSnapshot) => void): () => void {
  snapshotListeners.add(listener);
  return () => {
    snapshotListeners.delete(listener);
  };
}

/** Forget the floor and the seed: the session went, or tests. */
export function resetCrewCadenceLink(): void {
  revisionFloor = null;
  lastSnapshot = null;
}

/** Test-only. */
export function resetCrewCadenceForTests(): void {
  resetCrewCadenceLink();
  snapshotListeners.clear();
}

// ---------------------------------------------------------------------------
// Inputs this phone sends
// ---------------------------------------------------------------------------

/** What this phone would run on with no crew clock: its stage, else its settings. */
export type OwnRestPacing = CrewConfigFields;

/** A config the server accepts: the rest length rounded and clamped into its mode's bounds. */
export function normalizeCrewConfig(pacing: CrewConfigFields): CrewConfigFields {
  const bounds = CREW_REST_TARGET_SECONDS[pacing.mode];
  const targetSeconds =
    pacing.targetSeconds === null || pacing.targetSeconds <= 0
      ? null
      : Math.min(bounds.max, Math.max(bounds.min, Math.round(pacing.targetSeconds)));
  return {
    mode: pacing.mode,
    targetSeconds,
    autoAdvance: pacing.autoAdvance,
    advanceOn: pacing.advanceOn,
    source: pacing.source,
  };
}

/** The config as the mutation input carries it. */
export function toCrewConfigInput(pacing: CrewConfigFields): SessionRestCadenceConfigInput {
  return normalizeCrewConfig(pacing);
}

function elapsedSince(anchorMs: number | null, nowMs: number): number {
  if (anchorMs === null) return 0;
  return Math.min(MAX_ELAPSED_MS, Math.max(0, Math.round(nowMs - anchorMs)));
}

/** ARM with this phone's own pacing, counting from where its timer already is. */
export function buildArmInput(own: OwnRestPacing, state: RestTimerState, nowMs: number): SessionRestCadenceInput {
  return {
    action: 'ARM',
    config: toCrewConfigInput(own),
    // No anchor yet (after a tick, before the first one) leaves the crew clock waiting too.
    ...(state.anchorMs === null ? {} : { elapsedMs: elapsedSince(state.anchorMs, nowMs) }),
  };
}

/**
 * A rest restarting on this phone (back from the background, or a FIRE that
 * never landed) as the server's equivalent. On the deadline the restart is a
 * RESET; under a tick or send rule RESET would forget the tick the next advance
 * needs, so it is a CONFIGURE that moves only the anchor (contracts §10).
 */
export function buildRestartInput(
  config: CrewConfigFields,
  state: RestTimerState,
  nowMs: number,
): SessionRestCadenceInput {
  if (config.mode === 'afterTick' && config.advanceOn === 'deadline') return { action: 'RESET', isRunning: true };
  return {
    action: 'CONFIGURE',
    config: toCrewConfigInput(config),
    anchor: 'NOW',
    elapsedMs: elapsedSince(state.anchorMs, nowMs),
  };
}

export type CrewAnchorRequest = 'KEEP' | 'NOW' | 'CLEAR';

/**
 * The CONFIGURE a settings edit or a stage change sends: this phone's own
 * pacing, with the anchor the change calls for. A change of mode moves the
 * anchor whatever was asked (an on-the-minute clock starts its beat now; an
 * after-tick one waits for a tick), because a kept anchor means something else
 * in the other mode. Null when the crew clock already runs on exactly this.
 */
export function buildConfigureInput({
  own,
  previous,
  anchor,
  elapsedFromLocalAnchor,
  state,
  nowMs,
}: {
  own: OwnRestPacing;
  /** The clock's config as this phone last knew it: the crew's, else what it last published. */
  previous: CrewConfigFields | null;
  anchor: CrewAnchorRequest;
  /** NOW counts from this phone's own anchor (a stage boundary it already applied) rather than from now. */
  elapsedFromLocalAnchor: boolean;
  state: RestTimerState;
  nowMs: number;
}): SessionRestCadenceInput | null {
  const config = normalizeCrewConfig(own);
  let resolvedAnchor: SessionRestCadenceAnchor = anchor;
  let fromLocalAnchor = elapsedFromLocalAnchor;
  if (anchor === 'KEEP' && previous !== null && previous.mode !== config.mode) {
    resolvedAnchor = config.mode === 'onTheMinute' ? 'NOW' : 'CLEAR';
    fromLocalAnchor = false;
  }
  const unchanged = sameCrewConfig(previous, config);
  if (unchanged && resolvedAnchor === 'KEEP') return null;
  if (unchanged && resolvedAnchor === 'CLEAR' && state.crew !== null && state.crew.anchorMs === null) return null;
  return {
    action: 'CONFIGURE',
    config,
    anchor: resolvedAnchor,
    ...(resolvedAnchor === 'NOW' ? { elapsedMs: fromLocalAnchor ? elapsedSince(state.anchorMs, nowMs) : 0 } : {}),
  };
}

/** A tick's TICK: how long ago the climb was logged, the queue item and how it went. */
export function buildTickInput(tick: RestTimerLastTick, tickStartMs: number, nowMs: number): SessionRestCadenceInput {
  return {
    action: 'TICK',
    tickStatus: tick.status,
    tickQueueItemUuid: tick.queueItemUuid,
    elapsedMs: Math.min(MAX_ELAPSED_MS, Math.max(0, Math.round(nowMs - tickStartMs))),
  };
}

// ---------------------------------------------------------------------------
// The holder's FIRE
// ---------------------------------------------------------------------------

/**
 * The beat a FIRE for `localDeadlineMs` claims, on the server's clock, worked
 * out from the crew clock's own server anchor rather than the converted local
 * deadline, so it is the exact instant the server derives. Null when the clock
 * has no anchor or no rest length.
 */
export function crewBeatServerMs(crew: CrewRestCadence, localDeadlineMs: number): number | null {
  const config = crew.config;
  if (config === null || crew.anchorServerMs === null || config.targetSeconds === null || config.targetSeconds <= 0) {
    return null;
  }
  const intervalMs = config.targetSeconds * 1000;
  if (config.mode === 'afterTick') return crew.anchorServerMs + intervalMs;
  const beats = Math.max(1, Math.round((localToServerMs(localDeadlineMs) - crew.anchorServerMs) / intervalMs));
  return crew.anchorServerMs + beats * intervalMs;
}

/**
 *   advance   the server took the beat: move the wall
 *   retry     the beat can still be taken: FIRE again at `atServerMs`
 *   claimed   the beat was already taken (another phone, or an earlier FIRE)
 *   lost      the beat is more than 5 s gone by the server's clock
 *   refused   the clock no longer has this beat (paused, re-anchored, off)
 */
export type CrewFireOutcome =
  | { kind: 'advance' }
  | { kind: 'retry'; atServerMs: number }
  | { kind: 'claimed' }
  | { kind: 'lost' }
  | { kind: 'refused' };

/**
 * What a FIRE reply means for the beat. A refusal whose clock still has the
 * beat, unclaimed, came from timing: the server's clock had not reached the
 * beat's window yet (retry at the beat), or another write landed first and
 * moved the revision (retry now, on the new one). Both are bounded by
 * MAX_CREW_FIRE_RETRIES, and the server takes each beat once whatever is sent.
 */
export function planCrewFireOutcome({
  applied,
  change,
  beatServerMs,
  attempt,
}: {
  applied: boolean;
  change: SessionRestCadenceChangeWire;
  beatServerMs: number;
  attempt: number;
}): CrewFireOutcome {
  if (applied) return { kind: 'advance' };
  const wire = change.restCadence ?? null;
  if (wire === null) return { kind: 'refused' };
  const lastFiredMs = parseServerMs(wire.lastFiredBeatAt);
  if (lastFiredMs !== null && lastFiredMs >= beatServerMs) return { kind: 'claimed' };
  const config = parseCrewConfig(wire);
  const anchorMs = parseServerMs(wire.anchorAt);
  if (config === null || !wire.isRunning || !config.autoAdvance || anchorMs === null) return { kind: 'refused' };
  if (config.targetSeconds === null || config.targetSeconds <= 0) return { kind: 'refused' };
  const intervalMs = config.targetSeconds * 1000;
  const stillTheBeat =
    config.mode === 'afterTick'
      ? anchorMs + intervalMs === beatServerMs
      : beatServerMs > anchorMs && (beatServerMs - anchorMs) % intervalMs === 0;
  if (!stillTheBeat) return { kind: 'refused' };
  const serverNowMs = Number(change.serverNow);
  if (!Number.isFinite(serverNowMs)) return { kind: 'refused' };
  if (serverNowMs - beatServerMs > CREW_FIRE_LATE_TOLERANCE_MS) return { kind: 'lost' };
  if (attempt >= MAX_CREW_FIRE_RETRIES) return { kind: 'refused' };
  return {
    kind: 'retry',
    atServerMs: serverNowMs < beatServerMs - CREW_FIRE_EARLY_TOLERANCE_MS ? beatServerMs : serverNowMs,
  };
}
