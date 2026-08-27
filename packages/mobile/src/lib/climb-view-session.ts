// Session-scoped board-render telemetry (issue #2202) — the mobile call
// surface over the shared board-render event builders (`@boardsesh/analytics`).
// "Session" means this JS run: every store here is a plain module-level
// singleton, reset only by an app relaunch (or `_resetClimbViewSessionForTests`
// in tests). Full contract: docs/board-render-analytics.md.
//
// Three entry points, one state machine per viewed climb:
//  - `markClimbViewed` opens a view and fires `Climb View Opened`.
//  - `markClimbAction` closes it (fires `Climb First Action`) the first time
//    the climber does something with it — never twice for the same view.
//  - `noteBoardPinch` is independent of the other two (a pinch needs no prior
//    "view" bookkeeping) but shares the same common-props contract.

import { boardPinch, climbFirstAction, climbViewOpened, type BoardRenderTelemetryProps } from '@boardsesh/analytics';
import { track } from './analytics';

export type ClimbActionType = 'queue' | 'ble';

type ClimbViewState = {
  climbUuid: string;
  openedAtMs: number;
  actioned: boolean;
  /** The common props at the moment the view opened — reused for the first
   *  action so a caller far from any board context (a BLE send callback) can
   *  still fire a fully-populated event. */
  commonProps: BoardRenderTelemetryProps;
};

/** Every climb uuid ever passed to `markClimbViewed` this app run. */
const seenClimbUuids = new Set<string>();
/**
 * The ONE open view — the climb currently drawn on the board — or null once it
 * has been actioned.
 *
 * Deliberately a single slot rather than a map keyed by climb uuid. Only one
 * climb is on the board at a time, so a second open view could only ever be a
 * stale one, and a stale view is not harmless: it makes `ms_since_open` measure
 * from an unrelated earlier moment. The repro that forced this — view climb X,
 * browse for twenty minutes, then tap X again under Similar Climbs (where
 * `addToQueue` runs BEFORE `setCurrentClimb`) — produced a
 * `Climb First Action { ms_since_open: ~1_200_000 }` describing twenty minutes
 * of browsing rather than the seconds the climber spent looking at the climb.
 * With one slot that queue add lands while another climb's view is open,
 * matches nothing, and correctly fires nothing.
 *
 * `seenClimbUuids` stays a per-app-run Set on purpose: `reopened_in_session` is
 * a statement about the whole launch, not about the open view.
 */
let openView: ClimbViewState | null = null;

/**
 * A pinch gesture below this absolute scale delta is finger jitter, not a
 * deliberate zoom — see docs/board-render-analytics.md.
 */
const PINCH_MIN_SCALE_DELTA = 0.15;

/**
 * Monotonic milliseconds for the view clock.
 *
 * `Date.now()` is wall-clock and NOT monotonic — an NTP correction, a
 * timezone-driven adjustment or the climber editing the date mid-session can
 * move it backwards, which emits a negative or wildly inflated `ms_since_open`.
 * Hermes implements `performance.now()`; the fallback exists only for a JS
 * runtime (or a test double) that doesn't.
 */
function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/**
 * The climb drawn on the board changed. Fires `Climb View Opened` —
 * `reopened_in_session` is what lets a query distinguish a genuinely fresh view
 * from the climber navigating back to a climb already open once this app run.
 *
 * Opening a view CLOSES whatever view was open before it, actioned or not: the
 * previous climb is no longer on the board, so nothing the climber does next
 * can be a first action on it (see `openView`).
 *
 * Re-reporting the climb that is ALREADY open is a no-op. Two reporters call
 * this — the queue provider's current-climb effect and the play drawer's
 * preview latch — and they overlap by design when a previewed climb is
 * committed to the queue: the commit moves a climb the drawer was already
 * showing into the current slot, it does not draw anything new. Counting that
 * as a second view would inflate the denominator of every per-view rate the
 * A/B reads, and would reset `ms_since_open` on a climb the climber never
 * looked away from.
 */
export function markClimbViewed(climbUuid: string, commonProps: BoardRenderTelemetryProps): void {
  if (openView?.climbUuid === climbUuid) return;
  const reopenedInSession = seenClimbUuids.has(climbUuid);
  seenClimbUuids.add(climbUuid);
  openView = { climbUuid, openedAtMs: nowMs(), actioned: false, commonProps };

  const event = climbViewOpened({ ...commonProps, climb_uuid: climbUuid, reopened_in_session: reopenedInSession });
  track(event.name, event.properties);
}

/**
 * The climber did something with the climb they are looking at — added it to
 * the queue, or sent it to the board. Fires `Climb First Action` AT MOST ONCE
 * per `markClimbViewed` call: a no-op when this climb is not the open view (a
 * queue add straight from search with no prior climb view, or an action on a
 * climb that left the board a while ago) or the open view was already actioned.
 */
export function markClimbAction(climbUuid: string, actionType: ClimbActionType): void {
  const state = openView;
  if (!state || state.climbUuid !== climbUuid || state.actioned) return;
  state.actioned = true;

  const event = climbFirstAction({
    ...state.commonProps,
    climb_uuid: climbUuid,
    action_type: actionType,
    ms_since_open: nowMs() - state.openedAtMs,
  });
  track(event.name, event.properties);
}

/**
 * A 2-finger pinch gesture ended. Call this ONCE per gesture end (never per
 * frame) — the gating below is a floor on top of that, not a substitute for
 * it. Skips firing entirely when the gesture barely moved the scale, so
 * incidental finger jitter on an otherwise-static touch doesn't inflate the
 * pinch count.
 *
 * `scaleDelta` is SIGNED (end minus start) so a zoom-OUT clears the gate on its
 * own magnitude. Gating on `scaleMax - scaleStart` instead scores every
 * zoom-out at exactly 0 and drops it as jitter — how the first cut of this
 * event lost every gesture that only pulled back out.
 */
export function noteBoardPinch(
  commonProps: BoardRenderTelemetryProps,
  params: { scaleMax: number; scaleMin: number; scaleDelta: number },
): void {
  if (Math.abs(params.scaleDelta) < PINCH_MIN_SCALE_DELTA) return;
  const event = boardPinch({
    ...commonProps,
    scale_max: params.scaleMax,
    scale_min: params.scaleMin,
    scale_delta: params.scaleDelta,
  });
  track(event.name, event.properties);
}

/** Test-only: forget every view/session marker between cases. */
export function _resetClimbViewSessionForTests(): void {
  seenClimbUuids.clear();
  openView = null;
}
