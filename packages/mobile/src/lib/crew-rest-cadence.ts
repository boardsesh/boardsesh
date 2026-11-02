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
//   - An armed clock is taken when this phone is already armed for that
//     session, or another member set it, or (on the subscribe seed only) this
//     phone set it and has not turned the timer off here since launch. So a
//     cold start brings back the setter's live clock and the setter keeps
//     pacing the wall (Marco, 2026-10-25), while an echo of this phone's own
//     ARM can never re-arm a timer it has since turned off.
//   - A mode or advance rule this app does not know makes the clock
//     unsupported: it is held (config null) so the scheduler never fires on it.
//   - Every instant is server epoch ms on the wire and is converted when the
//     change is taken, through the server clock offset (server-clock.ts). A
//     later sample that moves the offset by more than 250 ms converts the held
//     clock again, even from a change too old to take (adoptCrewCadence).
//   - `autoAdvanceOnce` (a 4x4 set rest: move the wall once, then wait) rides
//     in the config, so every CONFIGURE this phone re-sends from the clock it
//     holds keeps it, and a CONFIGURE without it clears it on the server.

import type {
  SessionRestCadenceAnchor,
  SessionRestCadenceConfigInput,
  SessionRestCadenceInput,
} from '@boardsesh/shared-schema/generated';
import type { RestTimerMode } from './rest-timer';
import type { CrewConfigFields, CrewRestConfig, RestAdvanceRule, RestTimerLastTick } from './rest-timer-pacing';
import type { SessionRestCadenceChangeWire, SessionRestCadenceWire } from './graphql/operations';
import {
  adoptCrewCadence,
  clearCrewCadence,
  crewConversionMoved,
  getRestTimerState,
  setCrewRestPacingDraft,
  type RestTimerState,
} from './rest-timer-store';
import { noteServerTimeFromEvent, noteServerTimeFromMutation, serverToLocalMs, localToServerMs } from './server-clock';

export { spendAdvanceOnce, type CrewConfigFields } from './rest-timer-pacing';

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
/**
 * How much closer than one rest an after-tick beat may sit to the last one the
 * server took and still be taken (REST_CADENCE_AFTER_TICK_SPACING_SLACK_MS).
 */
export const CREW_AFTER_TICK_SPACING_SLACK_MS = 3_000;
/**
 * The closest an on-the-minute beat may sit to the last one taken: the shortest
 * interval less that slack, 12 s (REST_CADENCE_ON_THE_MINUTE_MIN_SPACING_MS).
 */
export const CREW_ON_THE_MINUTE_MIN_SPACING_MS =
  CREW_REST_TARGET_SECONDS.onTheMinute.min * 1000 - CREW_AFTER_TICK_SPACING_SLACK_MS;

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
    // Null from a server that predates the flag: false, as it ran. Inert
    // without auto-advance (no FIRE applies), so it is held only with it.
    ...(wire.autoAdvance === true && wire.autoAdvanceOnce === true ? { autoAdvanceOnce: true as const } : {}),
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

/** Field by field, so a freshly built config compares equal to the one held. */
export function sameCrewConfig(left: CrewConfigFields | null, right: CrewConfigFields | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.mode === right.mode &&
    left.targetSeconds === right.targetSeconds &&
    left.autoAdvance === right.autoAdvance &&
    (left.autoAdvanceOnce === true) === (right.autoAdvanceOnce === true) &&
    left.advanceOn === right.advanceOn &&
    left.source === right.source
  );
}

// ---------------------------------------------------------------------------
// Taking a change: the revision floor, the adoption rule, the seed
// ---------------------------------------------------------------------------

let revisionFloor: { sessionId: string; revision: number } | null = null;

/** This phone's participant id in a session, as the last change for it said. */
let ownParticipant: { sessionId: string; participantId: string } | null = null;

/**
 * Sessions whose rest timer the climber turned off on this phone since launch.
 * A seed carrying a clock this phone set is not taken for these: the off was
 * the climber's, and a DISARM that never reached the server must not come back
 * on with the next seed. Lives as long as the JS runtime, so a cold start
 * starts with none.
 */
const turnedOffHere = new Set<string>();

/** The climber turned the timer off on this phone in this session (the publisher's DISARM). */
export function noteCrewClockTurnedOffHere(sessionId: string): void {
  turnedOffHere.add(sessionId);
}

/** The climber turned it on again here: a seed may bring it back after all. */
export function noteCrewClockArmedHere(sessionId: string): void {
  turnedOffHere.delete(sessionId);
}

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

  if (ownParticipantId !== null) ownParticipant = { sessionId, participantId: ownParticipantId };
  if (revisionFloor?.sessionId !== sessionId) revisionFloor = null;
  if (!change.isSnapshot && revisionFloor !== null && change.revision <= revisionFloor.revision) {
    // Too old to take, but its clock sample still counts: a FIRE that came back
    // refused or too late is often the round trip that shows the offset was out.
    reconvertHeldCrewCadence(sessionId);
    return 'stale';
  }
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
  // A cold start (or a rejoin) brings back a live clock this phone set, so the
  // setter keeps pacing the wall. Only from the seed: an echo of this phone's
  // own ARM after it turned the timer off must never turn it back on.
  const restoresOwnClock =
    change.isSnapshot && setBy !== null && setBy === ownParticipantId && !state.armed && !turnedOffHere.has(sessionId);
  if (!armedFor(state, sessionId) && !setByAnotherMember && !restoresOwnClock) return 'ignored';
  const crew = parseCrewRestCadence(sessionId, change.revision, wire);
  adoptCrewCadence(crew, { replaceLocal: change.isSnapshot });
  return crew.config === null ? 'unsupported' : 'adopted';
}

/**
 * Convert the held clock's server instants again with the offset as it stands
 * now, when that moves one of them past the threshold. adoptCrewCadence keeps
 * an action of this phone's own that is still waiting for its echo.
 */
function reconvertHeldCrewCadence(sessionId: string): void {
  const { crew } = getRestTimerState();
  if (crew === null || crew.sessionId !== sessionId || crew.config === null) return;
  const anchorMs = crew.anchorServerMs === null ? null : serverToLocalMs(crew.anchorServerMs);
  const lastFiredBeatMs = crew.lastFiredBeatServerMs === null ? null : serverToLocalMs(crew.lastFiredBeatServerMs);
  if (!crewConversionMoved(crew.anchorMs, anchorMs) && !crewConversionMoved(crew.lastFiredBeatMs, lastFiredBeatMs)) {
    return;
  }
  adoptCrewCadence({ ...crew, anchorMs, lastFiredBeatMs });
}

/**
 * Whether the crew clock this phone follows was set by someone else: another
 * member's pacing, which a workout started here must override (Start and "Add
 * a block", rest-timer-effective.ts). True when this phone cannot tell, since
 * overriding its own clock's beat at a workout's start costs little.
 */
export function followsAnotherMembersCrewClock(): boolean {
  const { crew } = getRestTimerState();
  if (crew === null || crew.config === null) return false;
  const own = ownParticipant?.sessionId === crew.sessionId ? ownParticipant.participantId : null;
  return own === null || crew.config.setByParticipantId !== own;
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
  ownParticipant = null;
}

/** Test-only. */
export function resetCrewCadenceForTests(): void {
  resetCrewCadenceLink();
  snapshotListeners.clear();
  turnedOffHere.clear();
}

// ---------------------------------------------------------------------------
// Inputs this phone sends
// ---------------------------------------------------------------------------

/** What this phone would run on with no crew clock: its stage, else its settings. */
export type OwnRestPacing = CrewConfigFields;

/**
 * A config the server accepts: the rest length rounded and clamped into its
 * mode's bounds. `autoAdvanceOnce` is kept only while auto-advance is on (off,
 * it moves nothing), and left out otherwise, so every other config goes out
 * exactly as before the flag (the server reads it missing as false).
 */
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
    ...(pacing.autoAdvance && pacing.autoAdvanceOnce === true ? { autoAdvanceOnce: true as const } : {}),
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
 * needs, so it is a CONFIGURE that moves only the anchor (contracts §10). It
 * re-sends the clock's config as held, so a 4x4 set rest that restarts still
 * moves the wall only once.
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
  boundaryAtMs,
  state,
  nowMs,
}: {
  own: OwnRestPacing;
  /** The clock's config as this phone last knew it: the crew's, else what it last published. */
  previous: CrewConfigFields | null;
  anchor: CrewAnchorRequest;
  /**
   * NOW counts from this instant (a stage boundary this phone already applied,
   * sent after the debounce) rather than from now. Kept apart from the timer's
   * anchor, which a crew change taken meanwhile can replace.
   */
  boundaryAtMs: number | null;
  state: RestTimerState;
  nowMs: number;
}): SessionRestCadenceInput | null {
  const config = normalizeCrewConfig(own);
  let resolvedAnchor: SessionRestCadenceAnchor = anchor;
  let fromMs = boundaryAtMs;
  // Entering on the minute always starts the beat now, also when this phone
  // cannot tell the mode the clock had: kept, an after-tick anchor (a tick from
  // a minute ago, or none) would become the grid (contracts §16, Fable's PACE
  // review). Leaving it for after the tick waits for the next tick.
  const entersOnTheMinute = config.mode === 'onTheMinute' && (previous === null || previous.mode !== 'onTheMinute');
  if (anchor === 'KEEP' && (entersOnTheMinute || (previous !== null && previous.mode !== config.mode))) {
    resolvedAnchor = config.mode === 'onTheMinute' ? 'NOW' : 'CLEAR';
    fromMs = null;
  }
  const unchanged = sameCrewConfig(previous, config);
  if (unchanged && resolvedAnchor === 'KEEP') return null;
  if (unchanged && resolvedAnchor === 'CLEAR' && state.crew !== null && state.crew.anchorMs === null) return null;
  return {
    action: 'CONFIGURE',
    config,
    anchor: resolvedAnchor,
    ...(resolvedAnchor === 'NOW' ? { elapsedMs: elapsedSince(fromMs, nowMs) } : {}),
  };
}

/** What the timer's own controls change on a crew clock: one of the three the sheet shows. */
export type CrewRestPacingEdit = Partial<Pick<CrewConfigFields, 'targetSeconds' | 'mode' | 'autoAdvance'>>;

/**
 * The climber changed the crew clock's rest length, cadence or auto-advance
 * from the timer's sheet or the Record tab (Marco, 2026-10-25: in a crew those
 * controls show and change the crew's clock). The crew's config, as this phone
 * holds it or last edited it, with only that change; the advance rule stays,
 * and the source becomes 'settings', since a workout no longer set it. A 4x4
 * set rest's once-only advance stays too, unless the edit turns auto-advance
 * off: a longer set rest still moves the wall once, unless the server spent
 * that move before the edit went out. The publisher sends it as a CONFIGURE
 * (buildCrewPacingEditInput). False when this phone follows no
 * crew clock it can run, or nothing changed.
 */
export function editCrewRestPacing(edit: CrewRestPacingEdit): boolean {
  const state = getRestTimerState();
  const crewConfig = state.crew?.config ?? null;
  if (!state.armed || crewConfig === null) return false;
  const base = state.crewPacingDraft ?? crewConfig;
  const next = normalizeCrewConfig({ ...base, ...edit, source: 'settings' });
  if (sameCrewConfig(next, base)) return false;
  // Built from `next` alone, so a flag the edit dropped is not put back from `base`.
  return setCrewRestPacingDraft({ ...next, setByParticipantId: base.setByParticipantId });
}

/**
 * A crew pacing draft against the clock the server holds when it goes out. An
 * edit never sets the once-only advance, so a draft carries it only from the
 * clock it was made on, and its auto-advance with it. When the held clock no
 * longer has the flag, the server spent it (the holder's FIRE moved the wall)
 * or a CONFIGURE cleared it (the builder's next set) after the tap: the draft
 * takes the held auto-advance and leaves the flag off. Otherwise a rest-length
 * edit that crossed the set rest's beat would turn its move back on, and the
 * wall would move again after the next set's first rep.
 */
export function rebaseCrewPacingDraft(draft: CrewConfigFields, held: CrewConfigFields | null): CrewConfigFields {
  if (draft.autoAdvanceOnce !== true || held === null || held.autoAdvanceOnce === true) return draft;
  return {
    mode: draft.mode,
    targetSeconds: draft.targetSeconds,
    autoAdvance: held.autoAdvance,
    advanceOn: draft.advanceOn,
    source: draft.source,
  };
}

/**
 * The CONFIGURE for a crew pacing edit, against the config the server holds
 * (the draft rebased on it first, rebaseCrewPacingDraft), and the config it
 * sends. A change of cadence moves the anchor as the server's own rule for a
 * stage boundary does: on the minute starts its beat now, after the tick waits
 * for the next one. The same cadence keeps it, so a new rest length on the
 * minute keeps the crew's beat. Null when the server already holds exactly this.
 */
export function buildCrewPacingEditInput({
  draft,
  held,
}: {
  draft: CrewConfigFields;
  held: CrewConfigFields | null;
}): { input: SessionRestCadenceInput; config: CrewConfigFields } | null {
  const config = normalizeCrewConfig(rebaseCrewPacingDraft(draft, held));
  if (held !== null && sameCrewConfig(held, config)) return null;
  const anchor: SessionRestCadenceAnchor =
    held !== null && held.mode === config.mode ? 'KEEP' : config.mode === 'onTheMinute' ? 'NOW' : 'CLEAR';
  return { input: { action: 'CONFIGURE', config, anchor, ...(anchor === 'NOW' ? { elapsedMs: 0 } : {}) }, config };
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
 * Whether the server would refuse a FIRE for this beat however early or late
 * it came: too close to the last beat it took (its spacing fence, #6754). After
 * a tick, closer than one rest less 3 s; on the minute, closer than 12 s. Such
 * a refusal reads like "not due yet", so the phone checks first and lets the
 * beat go rather than send a FIRE, or a retry, the server will not take.
 */
export function crewBeatFenced(
  config: Pick<CrewConfigFields, 'mode' | 'targetSeconds'>,
  lastFiredBeatServerMs: number | null,
  beatServerMs: number,
): boolean {
  if (lastFiredBeatServerMs === null || config.targetSeconds === null) return false;
  const minSpacingMs =
    config.mode === 'afterTick'
      ? config.targetSeconds * 1000 - CREW_AFTER_TICK_SPACING_SLACK_MS
      : CREW_ON_THE_MINUTE_MIN_SPACING_MS;
  return beatServerMs < lastFiredBeatServerMs + minSpacingMs;
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
  // The spacing fence refuses the retry too: no use waiting for the beat.
  if (crewBeatFenced(config, lastFiredMs, beatServerMs)) return { kind: 'refused' };
  const serverNowMs = Number(change.serverNow);
  if (!Number.isFinite(serverNowMs)) return { kind: 'refused' };
  if (serverNowMs - beatServerMs > CREW_FIRE_LATE_TOLERANCE_MS) return { kind: 'lost' };
  if (attempt >= MAX_CREW_FIRE_RETRIES) return { kind: 'refused' };
  return {
    kind: 'retry',
    atServerMs: serverNowMs < beatServerMs - CREW_FIRE_EARLY_TOLERANCE_MS ? beatServerMs : serverNowMs,
  };
}
