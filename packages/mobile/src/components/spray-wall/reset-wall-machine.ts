// The reset-a-wall stepper, as a pure reducer (epic #5346, SW-13).
//
// A sibling of `add-wall-machine.ts` rather than a reuse of it, because the two
// flows disagree about the one thing that matters most in either of them: what
// anchors mean.
//
// On a NEW wall the anchors are optional and skipping is not a lesser outcome —
// with nothing to compare against, the canonical frame IS that photograph and
// the identity homography is true by definition. On a RESET it is the opposite.
// Version 1's photo frame is canonical forever, so from version 2 on the four
// corners are the only thing that says where this photograph's pixels sit in it,
// and the identity matrix would instead assert that the second photo has the
// same crop, framing and dimensions as the first. No phone honours that: the
// detections then arrive as raw photo pixels labelled canonical, and the matcher
// reports the whole wall removed and the whole photo added. Committing that
// takes every hold off the wall and breaks every climb on it.
//
// So `ANCHORS_DONE` is GATED here, the server refuses an anchor-less draft in
// both `proposeSprayWallReset` and `commitSprayWallVersion`, and the two agree
// on purpose — this gate is the one that can say so before a climber has spent
// four minutes uploading a photograph.
//
// Like its sibling, this file does no I/O. Every server call, the picker and the
// detector live in the screen and report what happened as an action.

import { isConvexQuad, type Quad } from '@boardsesh/spray-wall-geometry';
import type { SprayHoldCandidate } from '../outline-editor/spray-hold-editor-types';

/**
 * Where the climber is.
 *
 * There is no `meta` step: the wall already exists, with its name, angle and
 * visibility settled. `upload` covers the multipart POST and
 * `createSprayWallVersion` together, because neither is separately actionable.
 * `compare` is a whole other screen.
 */
export type ResetWallStep = 'photo' | 'anchors' | 'upload' | 'detect' | 'compare' | 'done';

/** A photo as the picker and the compressor left it: a local JPEG and its pixels. */
export type ResetPhoto = {
  uri: string;
  width: number;
  height: number;
  /** Which affordance produced it. Telemetry only. */
  source: 'library' | 'camera';
};

/** The draft version the upload step created (or resumed). */
export type ResetDraft = {
  versionId: string;
  versionNumber: number;
  /** The STORED photo's pixels, which is the space detections are measured in. */
  photoWidth: number;
  photoHeight: number;
};

/** Why the anchor quad was refused. */
export type ResetAnchorRejection = 'not-convex';

export type ResetDetectionOutcome = 'idle' | 'running' | 'done' | 'unavailable' | 'failed';

export type ResetWallState = {
  step: ResetWallStep;
  photo: ResetPhoto | null;
  /** The wall's four corners in `photo`'s pixels, TL/TR/BR/BL. Never null past `anchors`. */
  anchors: Quad | null;
  anchorRejection: ResetAnchorRejection | null;
  draft: ResetDraft | null;
  upload: {
    running: boolean;
    /** 0-1, or null when the platform cannot report bytes (indeterminate bar). */
    progress: number | null;
    error: string | null;
    attempts: number;
  };
  detection: {
    outcome: ResetDetectionOutcome;
    done: number;
    total: number;
    candidates: readonly SprayHoldCandidate[];
  };
};

export type ResetWallAction =
  | { type: 'PHOTO_PICKED'; photo: ResetPhoto }
  | { type: 'PHOTO_CONFIRMED' }
  | { type: 'ANCHORS_SET'; anchors: Quad }
  | { type: 'ANCHORS_CLEARED' }
  | { type: 'ANCHORS_DONE' }
  | { type: 'UPLOAD_STARTED' }
  | { type: 'UPLOAD_PROGRESS'; progress: number | null }
  | { type: 'UPLOAD_FAILED'; message: string }
  | { type: 'DRAFT_CREATED'; draft: ResetDraft }
  | { type: 'DETECTION_STARTED' }
  | { type: 'DETECTION_PROGRESS'; done: number; total: number }
  | { type: 'DETECTION_FINISHED'; candidates: readonly SprayHoldCandidate[] }
  | { type: 'DETECTION_UNAVAILABLE' }
  | { type: 'DETECTION_FAILED' }
  | { type: 'COMMITTED' }
  | { type: 'BACK' };

const NO_CANDIDATES: readonly SprayHoldCandidate[] = [];

export function initialResetWallState(): ResetWallState {
  return {
    step: 'photo',
    photo: null,
    anchors: null,
    anchorRejection: null,
    draft: null,
    upload: { running: false, progress: null, error: null, attempts: 0 },
    detection: { outcome: 'idle', done: 0, total: 0, candidates: NO_CANDIDATES },
  };
}

/**
 * Where `BACK` goes from each step.
 *
 * `compare` and `done` are absent: by then the draft version exists on the
 * server and has adopted the photo, so stepping back would offer to upload a
 * second photo onto a draft that already has one — which the one-draft-per-wall
 * rule refuses. The way out of `compare` is leaving, which keeps the draft.
 */
const BACK_TARGET: Partial<Record<ResetWallStep, ResetWallStep>> = {
  anchors: 'photo',
  upload: 'photo',
  detect: 'photo',
};

/**
 * Whether the anchors step may be left.
 *
 * THE gate. Four corners that describe a usable quadrilateral, or nothing else
 * in this flow is allowed to happen — see the note at the top of this file for
 * what an anchor-less reset does to a wall.
 */
export function anchorsAreReady(state: ResetWallState): boolean {
  return state.anchors != null && state.anchorRejection == null;
}

/** Whether leaving now keeps work the climber can come back to. */
export function leavingKeepsDraft(state: ResetWallState): boolean {
  return state.draft != null && state.step !== 'done';
}

/** Whether the flow is mid-request and a back gesture should be declined. */
export function isBusy(state: ResetWallState): boolean {
  return state.upload.running;
}

/**
 * Whether leaving needs to ask first — for EVERY way out, not just the one this
 * screen draws.
 *
 * Mid-request, because the callback would land on a route that has gone and a
 * half-sent photograph would be charged to the wrong attempt. And once the draft
 * exists, because it is on the server and the detections that make it reviewable
 * are not: they were computed from a local photograph. Walking out silently
 * leaves a draft nothing can resume, and the only way back is discarding it and
 * shooting the wall again.
 */
export function shouldConfirmLeave(state: ResetWallState): boolean {
  return isBusy(state) || leavingKeepsDraft(state);
}

/**
 * What the footer's Back does from here.
 *
 * Two outcomes and deliberately no third. There is no "ask, then pop" — that was
 * the bug: the footer asked, popped, and `beforeRemove` asked again on the way
 * out, so the second alert's "Stay" silently undid the answer given to the
 * first. Popping the route is what raises the question, exactly once, in the one
 * listener every exit passes through (the header's back button and the iOS
 * gesture have no other path). So the union has no branch that could prompt, and
 * a future "confirm here as well" cannot be added without changing this type.
 */
export type ResetBackAction = 'step-back' | 'pop-route';

export function resetBackAction(state: ResetWallState): ResetBackAction {
  // `photo` has nothing behind it and `compare` has nothing it may return to —
  // the draft is on the server by then. Both mean leaving.
  return state.draft || state.step === 'photo' || state.step === 'compare' ? 'pop-route' : 'step-back';
}

export function resetWallReducer(state: ResetWallState, action: ResetWallAction): ResetWallState {
  switch (action.type) {
    case 'PHOTO_PICKED':
      // A new photo invalidates the anchors — they were four points on the OTHER
      // picture — and resets the upload, whose attempts counted against a file
      // that is no longer the one being sent.
      return {
        ...state,
        photo: action.photo,
        anchors: null,
        anchorRejection: null,
        upload: { running: false, progress: null, error: null, attempts: 0 },
      };

    case 'PHOTO_CONFIRMED':
      return state.photo ? { ...state, step: 'anchors' } : state;

    case 'ANCHORS_SET': {
      // A bow-tie quad has a homography that maps the wall inside out, and the
      // backend's fallback for a degenerate quad is the identity matrix — so an
      // un-rejected crossed quad does not fail loudly here, it silently throws
      // the anchors away and lands on exactly the frame this flow exists to
      // prevent.
      if (!isConvexQuad(action.anchors)) {
        return { ...state, anchorRejection: 'not-convex' };
      }
      return { ...state, anchors: action.anchors, anchorRejection: null };
    }

    case 'ANCHORS_CLEARED':
      return { ...state, anchors: null, anchorRejection: null };

    case 'ANCHORS_DONE':
      // The gate. Nothing here is a "skip": a reset with no anchors is refused by
      // the server twice over, and letting the flow past this point would mean
      // uploading a photograph to be told so.
      if (!anchorsAreReady(state)) return state;
      return { ...state, step: 'upload' };

    case 'UPLOAD_STARTED':
      return {
        ...state,
        step: 'upload',
        upload: { running: true, progress: null, error: null, attempts: state.upload.attempts + 1 },
      };

    case 'UPLOAD_PROGRESS':
      if (!state.upload.running) return state;
      return { ...state, upload: { ...state.upload, progress: action.progress } };

    case 'UPLOAD_FAILED':
      // Stays on `upload` with the photo and the anchors intact, so "Try again"
      // retries the upload alone rather than restarting the flow.
      return { ...state, step: 'upload', upload: { ...state.upload, running: false, error: action.message } };

    case 'DRAFT_CREATED':
      return {
        ...state,
        step: 'detect',
        draft: action.draft,
        upload: { ...state.upload, running: false, progress: 1, error: null },
      };

    case 'DETECTION_STARTED':
      return {
        ...state,
        step: 'detect',
        detection: { outcome: 'running', done: 0, total: 0, candidates: NO_CANDIDATES },
      };

    case 'DETECTION_PROGRESS':
      if (state.detection.outcome !== 'running') return state;
      return { ...state, detection: { ...state.detection, done: action.done, total: action.total } };

    case 'DETECTION_FINISHED':
      return {
        ...state,
        step: 'compare',
        detection: { ...state.detection, outcome: 'done', candidates: action.candidates },
      };

    case 'DETECTION_UNAVAILABLE':
    case 'DETECTION_FAILED':
      // Both land on the compare screen, which refuses to review a reset with no
      // detections at all: the matcher compares two sets of circles, and an empty
      // second set means "the whole wall has gone". Unlike the add-a-wall flow,
      // where a phone with no detector still lands in the editor and places holds
      // by hand, there is no manual fallback for a reset — the thing being
      // reviewed IS what the detector found. The distinction survives for the
      // copy and the telemetry: "your phone cannot suggest holds" and "suggesting
      // holds went wrong" are different things to be told.
      return {
        ...state,
        step: 'compare',
        detection: {
          outcome: action.type === 'DETECTION_UNAVAILABLE' ? 'unavailable' : 'failed',
          done: 0,
          total: 0,
          candidates: NO_CANDIDATES,
        },
      };

    case 'COMMITTED':
      return { ...state, step: 'done' };

    case 'BACK': {
      // Never interrupt a request: the callback would land on a step that is no
      // longer showing it, and a half-uploaded photo would be charged to the
      // wrong attempt.
      if (isBusy(state)) return state;
      const target = BACK_TARGET[state.step];
      if (!target) return state;
      // Backing out of `anchors` keeps them: the climber may be checking the
      // photo, not replacing it. Picking a new photo is what clears them.
      return { ...state, step: target };
    }

    default:
      return state;
  }
}
