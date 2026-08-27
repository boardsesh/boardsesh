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
  openedAtMs: number;
  actioned: boolean;
  /** The common props at the moment the view opened — reused for the first
   *  action so a caller far from any board context (a BLE send callback) can
   *  still fire a fully-populated event. */
  commonProps: BoardRenderTelemetryProps;
};

/** Every climb uuid ever passed to `markClimbViewed` this app run. */
const seenClimbUuids = new Set<string>();
/** The CURRENT open view per climb uuid — cleared once actioned, kept
 *  otherwise so a late action still finds it. */
const viewedClimbs = new Map<string, ClimbViewState>();

/**
 * A pinch gesture below this absolute scale delta is finger jitter, not a
 * deliberate zoom — see docs/board-render-analytics.md.
 */
const PINCH_MIN_SCALE_DELTA = 0.15;

/**
 * A climb became the active/viewed climb. Fires `Climb View Opened` every
 * time — `reopened_in_session` is what lets a query distinguish a genuinely
 * fresh view from the climber navigating back to a climb already open once
 * this app run.
 */
export function markClimbViewed(climbUuid: string, commonProps: BoardRenderTelemetryProps): void {
  const reopenedInSession = seenClimbUuids.has(climbUuid);
  seenClimbUuids.add(climbUuid);
  viewedClimbs.set(climbUuid, { openedAtMs: Date.now(), actioned: false, commonProps });

  const event = climbViewOpened({ ...commonProps, climb_uuid: climbUuid, reopened_in_session: reopenedInSession });
  track(event.name, event.properties);
}

/**
 * The climber did something with a viewed climb — added it to the queue, or
 * sent it to the board. Fires `Climb First Action` AT MOST ONCE per
 * `markClimbViewed` call: a no-op if this climb was never marked viewed (a
 * queue add from search, say, with no prior climb view) or already actioned.
 */
export function markClimbAction(climbUuid: string, actionType: ClimbActionType): void {
  const state = viewedClimbs.get(climbUuid);
  if (!state || state.actioned) return;
  state.actioned = true;

  const event = climbFirstAction({
    ...state.commonProps,
    climb_uuid: climbUuid,
    action_type: actionType,
    ms_since_open: Date.now() - state.openedAtMs,
  });
  track(event.name, event.properties);
}

/**
 * A 2-finger pinch gesture ended. Call this ONCE per gesture end (never per
 * frame) — the gating below is a floor on top of that, not a substitute for
 * it. Skips firing entirely when the gesture barely moved the scale, so
 * incidental finger jitter on an otherwise-static touch doesn't inflate the
 * pinch count.
 */
export function noteBoardPinch(
  commonProps: BoardRenderTelemetryProps,
  params: { scaleMax: number; scaleDelta: number },
): void {
  if (Math.abs(params.scaleDelta) < PINCH_MIN_SCALE_DELTA) return;
  const event = boardPinch({ ...commonProps, scale_max: params.scaleMax });
  track(event.name, event.properties);
}

/** Test-only: forget every view/session marker between cases. */
export function _resetClimbViewSessionForTests(): void {
  seenClimbUuids.clear();
  viewedClimbs.clear();
}
