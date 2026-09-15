// The add-a-wall stepper, as a pure reducer (epic #5346, SW-09).
//
// Seven steps, four of which can fail, three of which talk to a server, and one
// of which is a whole other screen. Written as a reducer rather than a pile of
// `useState` for the reason every step in the flow shares: **going back must not
// lose anything.** A climber who reaches the anchors step, changes their mind
// about the photo, backs up and picks a different one has to arrive at a state
// where the FIRST photo's anchors are gone (they described a different picture)
// but the wall's name, angle and visibility are untouched. That is a transition
// table, and a transition table is a thing worth testing on its own.
//
// What this file deliberately does NOT do is any I/O. Every server call, the
// picker, the detector and the editor live in the screen; each one reports what
// happened as an action. So the awkward cases — an upload that fails halfway, a
// model that never downloads, a publish that is refused — are unit tests rather
// than something you can only reach by standing in front of a wall with a phone.

import { isConvexQuad, type Quad } from '@boardsesh/spray-wall-geometry';
import type { SprayHoldCandidate } from '../outline-editor/spray-hold-editor-types';

/**
 * Where the climber is.
 *
 * `upload` covers everything between "the photo is chosen" and "the draft
 * version exists" — the wall row, the multipart POST and `createSprayWallVersion`
 * — because none of the three is separately actionable: they retry together and
 * they fail into the same place.
 */
export type AddWallStep =
  | 'resuming'
  | 'meta'
  | 'photo'
  | 'anchors'
  | 'upload'
  | 'detect'
  | 'review'
  | 'publish'
  | 'done';

/** A photo as the picker and the compressor left it: a local JPEG and its pixels. */
export type PickedWallPhoto = {
  uri: string;
  width: number;
  height: number;
  /** Which affordance produced it. Telemetry only. */
  source: 'library' | 'camera';
};

/**
 * The wall row, once it exists — with or without a version on it yet.
 *
 * `createSprayWall` writes a REAL `user_boards` row, and it has to: the photo
 * handler authorises an upload against a wall the caller owns. So from that
 * moment the wall counts against the ten-wall cap and is something the climber
 * can come back to, which is why it is machine state and not a ref — a ref dies
 * with the mount, and the wall does not.
 */
export type CreatedWall = {
  wallUuid: string;
  layoutId: number;
  viewerCanEdit: boolean;
};

/** The wall plus the draft version the upload step adopted a photo onto. */
export type CreatedWallDraft = CreatedWall & {
  versionId: string;
  versionNumber: number;
};

/** Why the anchor quad was refused. */
export type AnchorRejection = 'not-convex';

export type DetectionOutcome = 'idle' | 'running' | 'done' | 'unavailable' | 'failed';

export type AddWallState = {
  step: AddWallStep;
  photo: PickedWallPhoto | null;
  /** The wall's four corners in `photo`'s pixels, TL/TR/BR/BL. Null = use the photo frame. */
  anchors: Quad | null;
  anchorRejection: AnchorRejection | null;
  /**
   * The wall row, once it exists on the server.
   *
   * Survives every failure after it, and is never created twice: a retried
   * upload reuses it. Without that, three taps on "Try again" would leave three
   * walls behind against a cap of ten.
   */
  wall: CreatedWall | null;
  /** The wall's one open draft version, once a photo has been adopted onto it. */
  draft: CreatedWallDraft | null;
  /**
   * Whether the version was published.
   *
   * LATCHED separately from the step, because publishing and BINDING the wall as
   * the active board are two writes behind one button. If the bind fails, the
   * retry must bind again and NOT re-publish — `publishSprayWallVersion` refuses
   * a version that is already published, so a shared retry turns a recoverable
   * hiccup into a dead end.
   */
  published: boolean;
  upload: {
    running: boolean;
    /** 0–1, or null when the platform cannot report bytes (indeterminate bar). */
    progress: number | null;
    error: string | null;
    /** How many times the upload has been attempted for this photo. */
    attempts: number;
  };
  detection: {
    outcome: DetectionOutcome;
    /** Tiles finished / tiles planned, for the progress bar. */
    done: number;
    total: number;
    candidates: readonly SprayHoldCandidate[];
  };
  publish: {
    running: boolean;
    error: string | null;
  };
  /**
   * Whether the editor has ever reported a successful save.
   *
   * LATCHED, and that is the point: the summary reports what ONE save applied,
   * so a second save that only deletes holds writes zero — and a gate on the
   * count would re-lock "Done" on a wall that is finished. What unlocks
   * publishing is that the draft has been written to at all.
   */
  hasSavedHolds: boolean;
  /** What the most recent save wrote. Display only — it is not the wall's total. */
  savedHoldCount: number;
};

export type AddWallAction =
  | { type: 'RESUME_CHECK_STARTED' }
  | { type: 'RESUME_DECLINED' }
  | { type: 'RESUMED_AT_PHOTO'; wall: CreatedWall }
  | { type: 'RESUMED_AT_REVIEW'; draft: CreatedWallDraft; savedHoldCount?: number }
  | { type: 'META_DONE' }
  | { type: 'PHOTO_PICKED'; photo: PickedWallPhoto }
  | { type: 'PHOTO_CONFIRMED' }
  | { type: 'ANCHORS_SET'; anchors: Quad }
  | { type: 'ANCHORS_CLEARED' }
  | { type: 'ANCHORS_DONE' }
  | { type: 'UPLOAD_STARTED' }
  | { type: 'UPLOAD_PROGRESS'; progress: number | null }
  | { type: 'UPLOAD_FAILED'; message: string }
  | { type: 'WALL_CREATED'; wall: CreatedWall }
  | { type: 'DRAFT_CREATED'; draft: CreatedWallDraft }
  | { type: 'DETECTION_STARTED' }
  | { type: 'DETECTION_PROGRESS'; done: number; total: number }
  | { type: 'DETECTION_FINISHED'; candidates: readonly SprayHoldCandidate[] }
  | { type: 'DETECTION_UNAVAILABLE' }
  | { type: 'DETECTION_FAILED' }
  | { type: 'HOLDS_SAVED'; holdCount: number }
  | { type: 'REVIEW_DONE' }
  | { type: 'PUBLISH_STARTED' }
  | { type: 'PUBLISH_FAILED'; message: string }
  | { type: 'PUBLISHED' }
  | { type: 'BACK' };

const NO_CANDIDATES: readonly SprayHoldCandidate[] = [];

export function initialAddWallState(): AddWallState {
  return {
    step: 'resuming',
    photo: null,
    anchors: null,
    anchorRejection: null,
    wall: null,
    draft: null,
    published: false,
    upload: { running: false, progress: null, error: null, attempts: 0 },
    detection: { outcome: 'idle', done: 0, total: 0, candidates: NO_CANDIDATES },
    publish: { running: false, error: null },
    hasSavedHolds: false,
    savedHoldCount: 0,
  };
}

/**
 * Where `BACK` goes from each step.
 *
 * `review` and `publish` are absent on purpose. By then the wall and its draft
 * version exist on the server and the photo has been adopted; stepping back into
 * `upload` would offer to upload a second photo onto a draft that already has
 * one, and the one-draft-per-wall rule would refuse it. The way out of those two
 * is leaving the flow, which keeps the draft for later.
 */
const BACK_TARGET: Partial<Record<AddWallStep, AddWallStep>> = {
  photo: 'meta',
  anchors: 'photo',
  upload: 'photo',
  detect: 'photo',
};

/**
 * Whether this step is somewhere a climber may leave without losing work they
 * cannot get back.
 *
 * True everywhere: before `upload` there is nothing on the server, and from
 * `upload` onwards the wall and its draft are persisted and can be finished
 * later. What this answers is whether leaving needs to SAY so, which is only
 * true once the wall exists.
 */
export function leavingKeepsDraft(state: AddWallState): boolean {
  return state.draft != null && state.step !== 'done';
}

/**
 * Whether the flow has left a wall row on the server that the climber has not
 * finished.
 *
 * Wider than `leavingKeepsDraft`: a wall created for an upload that then failed
 * has no version at all, so there is no draft to keep — but the ROW is there, it
 * counts against the ten-wall cap, and the next run of this flow has to find it
 * rather than mint another one beside it.
 */
export function hasUnfinishedWall(state: AddWallState): boolean {
  return state.wall != null && !state.published;
}

/**
 * Whether leaving the flow needs to be confirmed first.
 *
 * The one predicate for every way out — the footer's Back, the header's back
 * button, the iOS back gesture and Android's Back key. They all have to agree,
 * because a climber who is asked before one and silently dropped by another has
 * learned that the app does not mean it.
 *
 * Two reasons to ask. The flow is mid-request, where leaving strands a write
 * nobody will hear the answer to; or a draft exists, where the wall is kept but
 * the editor may hold holds it has not written yet — which only the editor
 * knows, so this asks whenever there is a draft at all rather than pretending to
 * know better.
 */
export function shouldConfirmLeave(state: AddWallState): boolean {
  return isBusy(state) || leavingKeepsDraft(state);
}

/** Whether the flow is mid-request and a back gesture should be declined. */
export function isBusy(state: AddWallState): boolean {
  return state.upload.running || state.detection.outcome === 'running' || state.publish.running;
}

export function addWallReducer(state: AddWallState, action: AddWallAction): AddWallState {
  switch (action.type) {
    case 'RESUME_CHECK_STARTED':
      return { ...state, step: 'resuming' };

    case 'RESUME_DECLINED':
      // Either there was nothing to resume, or the climber chose to start over
      // and the old wall has been cleaned up. Either way this is a fresh wall.
      return { ...state, step: 'meta', wall: null, draft: null };

    case 'RESUMED_AT_PHOTO':
      // The wall exists but no photo was ever adopted onto it. Its name, angle
      // and visibility are already stored on the row, so the meta step has
      // nothing left to ask and the flow rejoins at the photo.
      return { ...state, step: 'photo', wall: action.wall, draft: null };

    case 'RESUMED_AT_REVIEW': {
      // A draft version with a photo: the holds are the only thing left. No
      // second detector run — the candidates from the first pass were either
      // ruled on or are gone, and re-suggesting over saved holds would draw
      // every one of them twice.
      //
      // Holds already on the draft ARE saved holds, and saying so is what
      // unlocks Done. The editor loads them clean, so its Save is disabled
      // (nothing dirty) — a Done still waiting for a save of its own would leave
      // the climber unable to publish without a pointless edit.
      const resumedHolds = Math.max(0, action.savedHoldCount ?? 0);
      return {
        ...state,
        step: 'review',
        wall: {
          wallUuid: action.draft.wallUuid,
          layoutId: action.draft.layoutId,
          viewerCanEdit: action.draft.viewerCanEdit,
        },
        draft: action.draft,
        detection: { outcome: 'idle', done: 0, total: 0, candidates: NO_CANDIDATES },
        hasSavedHolds: state.hasSavedHolds || resumedHolds > 0,
        savedHoldCount: resumedHolds,
      };
    }

    case 'META_DONE':
      return { ...state, step: 'photo' };

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
      // The one validation the client owes the server. A bow-tie quad has a
      // homography that maps the wall inside out, and the backend's fallback for
      // a degenerate quad is the identity matrix — so an un-rejected crossed quad
      // does not fail loudly, it silently throws the anchors away and puts every
      // hold somewhere plausible but wrong.
      if (!isConvexQuad(action.anchors)) {
        return { ...state, anchorRejection: 'not-convex' };
      }
      return { ...state, anchors: action.anchors, anchorRejection: null };
    }

    case 'ANCHORS_CLEARED':
      return { ...state, anchors: null, anchorRejection: null };

    case 'ANCHORS_DONE':
      // Skipping is the default and is not a lesser outcome: with no anchors the
      // canonical frame is the photo's own pixel box, which is exactly right for
      // a wall photographed square on.
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
      // Stays on `upload` with the photo and the wall intact, so "Try again"
      // retries the upload alone rather than restarting the flow.
      return { ...state, step: 'upload', upload: { ...state.upload, running: false, error: action.message } };

    case 'WALL_CREATED':
      return { ...state, wall: action.wall };

    case 'DRAFT_CREATED':
      return {
        ...state,
        step: 'detect',
        wall: {
          wallUuid: action.draft.wallUuid,
          layoutId: action.draft.layoutId,
          viewerCanEdit: action.draft.viewerCanEdit,
        },
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
        step: 'review',
        detection: { ...state.detection, outcome: 'done', candidates: action.candidates },
      };

    case 'DETECTION_UNAVAILABLE':
    case 'DETECTION_FAILED':
      // Both land in the editor with nothing to review. The distinction is kept
      // for the copy and the telemetry — "this build cannot suggest holds" and
      // "suggesting holds went wrong" are different things to be told — but
      // neither is a dead end, because the editor is the product either way.
      return {
        ...state,
        step: 'review',
        detection: {
          outcome: action.type === 'DETECTION_UNAVAILABLE' ? 'unavailable' : 'failed',
          done: 0,
          total: 0,
          candidates: NO_CANDIDATES,
        },
      };

    case 'HOLDS_SAVED':
      // Stays on `review`. Saving is not leaving: a climber who has just written
      // forty holds very often wants to keep going, and advancing out from under
      // them would make the editor's own Save feel like a commit it is not. What
      // it does is unlock "Done".
      return { ...state, hasSavedHolds: true, savedHoldCount: action.holdCount };

    case 'REVIEW_DONE':
      // Refused with nothing saved. Publishing a version with no holds creates a
      // wall that cannot hold a climb, and the draft is still there to be
      // finished — so the honest answer is "save your holds first", which is
      // what the disabled action says.
      if (state.step !== 'review' || !state.hasSavedHolds) return state;
      return { ...state, step: 'publish', publish: { running: false, error: null } };

    case 'PUBLISH_STARTED':
      return { ...state, step: 'publish', publish: { running: true, error: null } };

    case 'PUBLISH_FAILED':
      // Back onto the publish step so the retry is reachable — including when
      // the failure was the BIND rather than the publish, which leaves
      // `published` latched and is why the retry does not re-publish.
      return { ...state, step: 'publish', publish: { running: false, error: action.message } };

    case 'PUBLISHED':
      return { ...state, step: 'done', published: true, publish: { running: false, error: null } };

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
