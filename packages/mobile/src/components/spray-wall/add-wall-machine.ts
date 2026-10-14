// The add-a-wall stepper, as a pure reducer (epic #5346, SW-09).
//
// Ten steps, five of which can fail, four of which talk to a server, and one
// of which is a whole other screen. Written as a reducer rather than a pile of
// `useState` for the reason every step in the flow shares: **going back must not
// lose anything.** A climber who reaches the anchors step, changes their mind
// about the photo, backs up and picks a different one has to arrive at a state
// where the FIRST photo's anchors are gone (they described a different picture)
// but the wall row and its draft are untouched. That is a transition
// table, and a transition table is a thing worth testing on its own.
//
// What this file deliberately does NOT do is any I/O. Every server call, the
// picker, the detector and the editor live in the screen; each one reports what
// happened as an action. So the awkward cases — an upload that fails halfway, a
// model that never downloads, a publish that is refused — are unit tests rather
// than something you can only reach by standing in front of a wall with a phone.

import { isConvexQuad, type Quad } from '@boardsesh/spray-wall-geometry';
import type { SprayHoldCandidate } from '../outline-editor/spray-hold-editor-types';
import type { EditableWallPhoto } from '../../lib/spray/photo-edit';

/**
 * Where the climber is.
 *
 * The flow opens on `photo`: the photo is the interesting part, and the name,
 * angle and visibility come last (`details`), prefilled, so a climber can go from
 * photo to published wall without typing anything. `resuming` is a full-screen
 * wait used only by a reset and by a targeted open, which cannot show anything
 * until the server has answered; a plain run checks for an unfinished wall
 * BEHIND the photo step (`resumeCheck`).
 *
 * `upload` covers everything between "the photo is chosen" and "the draft
 * version exists" — the wall row, the multipart POST and `createSprayWallVersion`
 * — because none of the three is separately actionable: they retry together and
 * they fail into the same place.
 *
 * `adjust` is the photo step's "Crop or rotate", a detour rather than a stop on
 * the way: it is opened from `photo`, always returns there, and is not counted.
 */
export type AddWallStep =
  | 'resuming'
  | 'photo'
  | 'adjust'
  | 'anchors'
  | 'upload'
  | 'detect'
  | 'review'
  | 'background'
  | 'look'
  | 'details'
  | 'publish'
  | 'done';

/**
 * A photo as the picker and the compressor left it (a local JPEG and its
 * pixels), plus what the crop step needs to re-edit it (`photo-edit.ts`).
 */
export type PickedWallPhoto = EditableWallPhoto & {
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
  /**
   * Whether the look for an unfinished wall to pick up has answered.
   *
   * `pending` from the start of a plain run, while the photo step shows: the
   * question is asked behind it, and the photo step's Next waits for the answer,
   * because going on would create a second wall beside the one the climber may
   * want back. Any resume answer settles it.
   */
  resumeCheck: 'pending' | 'settled';
  /**
   * A reset run: the clone's name, angle and visibility came from the wall it
   * replaces, so the look goes straight on to the publish.
   */
  skipsDetails: boolean;
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
    /**
     * The failure is one no retry can fix (a cap refusal): the server will say
     * the same thing again, so the step offers no "Try again".
     */
    final: boolean;
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
   * The details step's save (`updateSprayWall`). Busy like a publish: its
   * success moves the flow on to publish, so nothing may leave under it.
   */
  details: {
    saving: boolean;
    error: string | null;
  };
  /**
   * The look step's save is in flight. Busy like an upload or a publish: its
   * success moves the flow on to publish, so nothing may leave under it.
   */
  lookSaving: boolean;
  /**
   * The crop step is rendering the edited photo. Busy like an upload: Back and
   * leaving wait for it, so the render cannot land on a step that has moved on.
   */
  photoProcessing: boolean;
  /**
   * How many holds the draft carries: what a resumed draft already had, then
   * what the editor's commit left on it. Display and telemetry only — the
   * editor itself refuses to commit an empty wall.
   */
  savedHoldCount: number;
};

export type AddWallAction =
  | { type: 'RESUME_CHECK_STARTED' }
  | { type: 'RESUME_DECLINED' }
  | { type: 'RESUMED_AT_PHOTO'; wall: CreatedWall }
  | { type: 'RESUMED_AT_REVIEW'; draft: CreatedWallDraft; savedHoldCount?: number }
  | { type: 'PHOTO_PICKED'; photo: PickedWallPhoto }
  | { type: 'PHOTO_CONFIRMED' }
  /** "Crop or rotate" on the photo step. */
  | { type: 'ADJUST_OPENED' }
  | { type: 'PHOTO_PROCESSING_STARTED' }
  /** The edit rendered; `photo` is the new upload, still carrying its base and original. */
  | { type: 'PHOTO_ADJUSTED'; photo: PickedWallPhoto }
  | { type: 'PHOTO_PROCESSING_FAILED' }
  | { type: 'ANCHORS_SET'; anchors: Quad }
  | { type: 'ANCHORS_CLEARED' }
  | { type: 'ANCHORS_DONE' }
  | { type: 'UPLOAD_STARTED' }
  | { type: 'UPLOAD_PROGRESS'; progress: number | null }
  /** `final`: a refusal no retry can fix (a cap), so no "Try again" is offered. */
  | { type: 'UPLOAD_FAILED'; message: string; final?: boolean }
  | { type: 'WALL_CREATED'; wall: CreatedWall }
  | { type: 'DRAFT_CREATED'; draft: CreatedWallDraft }
  | { type: 'DETECTION_STARTED' }
  | { type: 'DETECTION_PROGRESS'; done: number; total: number }
  | { type: 'DETECTION_FINISHED'; candidates: readonly SprayHoldCandidate[] }
  | { type: 'DETECTION_UNAVAILABLE' }
  | { type: 'DETECTION_FAILED' }
  /** The editor saved every hold onto the draft; the look is all that is left before publishing. */
  | { type: 'REVIEW_COMMITTED'; holdCount: number }
  | { type: 'BACKGROUND_CONFIRMED' }
  | { type: 'LOOK_SAVE_STARTED' }
  | { type: 'LOOK_SAVE_FAILED' }
  /** The wall's look is stored on the server; the details (or, on a reset, the publish) are next. */
  | { type: 'LOOK_CONFIRMED' }
  | { type: 'DETAILS_SAVE_STARTED' }
  | { type: 'DETAILS_SAVE_FAILED'; message: string }
  /** The name, angle, gym and visibility are on the wall (or nothing changed); publishing is all that is left. */
  | { type: 'DETAILS_SAVED' }
  | { type: 'PUBLISH_STARTED' }
  | { type: 'PUBLISH_FAILED'; message: string }
  | { type: 'PUBLISHED' }
  | { type: 'BACK' };

const NO_CANDIDATES: readonly SprayHoldCandidate[] = [];

export function initialAddWallState(options?: { skipsDetails?: boolean }): AddWallState {
  return {
    step: 'photo',
    resumeCheck: 'pending',
    skipsDetails: options?.skipsDetails ?? false,
    photo: null,
    anchors: null,
    anchorRejection: null,
    wall: null,
    draft: null,
    published: false,
    upload: { running: false, progress: null, error: null, attempts: 0, final: false },
    detection: { outcome: 'idle', done: 0, total: 0, candidates: NO_CANDIDATES },
    publish: { running: false, error: null },
    details: { saving: false, error: null },
    lookSaving: false,
    photoProcessing: false,
    savedHoldCount: 0,
  };
}

/**
 * Where `BACK` goes from each step.
 *
 * `photo` is absent because it is the first step: Back there closes the flow.
 *
 * `detect`, `review`, `background` and `publish` are absent on purpose. By then the
 * wall and its draft version exist on the server and the photo has been adopted;
 * stepping back into `photo` would offer to upload a second photo onto a draft
 * that already has one, which `runUpload` declines outright — so the step would
 * sit there doing nothing at all, which is worse than having no way back. `background`
 * cannot step back into `review` either: the holds are already committed, and the
 * editor would reopen on them with nothing to ask. `look` returns to `background`,
 * and `details` to `look`, the screen handing the look step back the choice it
 * confirmed. The way out of the other four is leaving the flow, which keeps the
 * draft for later.
 *
 * `upload` keeps its way back because a draft cannot exist there: the action that
 * creates one is also the action that leaves the step.
 */
const BACK_TARGET: Partial<Record<AddWallStep, AddWallStep>> = {
  // Back on the crop step is Cancel: the edit is dropped, the photo is as it was.
  adjust: 'photo',
  anchors: 'photo',
  upload: 'photo',
  look: 'background',
  details: 'look',
};

/**
 * Whether the footer's Back LEAVES the flow rather than stepping back inside it.
 *
 * `photo` is the first step, so there is nothing behind it (nor behind the
 * `resuming` wait). `review`, `background` and `publish` have no step behind
 * them either — the draft is on the server by then (see `BACK_TARGET`). The
 * hold-look step returns to the background choice, and the details step to the
 * hold look. Leaving keeps the draft.
 */
export function backLeavesFlow(state: AddWallState): boolean {
  if (state.step === 'look' || state.step === 'details') return false;
  return (
    state.draft != null ||
    state.step === 'resuming' ||
    state.step === 'photo' ||
    state.step === 'review' ||
    state.step === 'background' ||
    state.step === 'publish'
  );
}

/**
 * Whether Back steps back INSIDE the flow from here: the header draws a chevron
 * rather than the X, and Android Back is taken by the flow rather than the stack.
 */
export function backStaysInFlow(state: AddWallState): boolean {
  return !backLeavesFlow(state) && BACK_TARGET[state.step] != null;
}

const COUNTED_STEPS: readonly AddWallStep[] = ['photo', 'anchors', 'review', 'background', 'look', 'details'];
const RESET_COUNTED_STEPS: readonly AddWallStep[] = ['photo', 'anchors', 'review', 'background', 'look'];

/**
 * The steps that get a "Step N of M" counter: the ones a climber drives.
 *
 * Publish is not one. It runs by itself the moment the last counted step saves,
 * so counting it would promise a step nobody stops on. A reset never shows the
 * details step (the clone's settings came from the wall it replaces), so it
 * counts one fewer.
 */
export function countedSteps(skipsDetails: boolean): readonly AddWallStep[] {
  return skipsDetails ? RESET_COUNTED_STEPS : COUNTED_STEPS;
}

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
  return isBusy(state) || state.detection.outcome === 'running' || leavingKeepsDraft(state);
}

/** Whether the flow is mid-request and a back gesture should be declined. */
export function isBusy(state: AddWallState): boolean {
  return (
    state.upload.running || state.publish.running || state.lookSaving || state.details.saving || state.photoProcessing
  );
}

/** What the hold editor knows that the machine does not, read at the moment of leaving. */
export type EditorLeaveState = {
  /** It holds decisions it has not written. */
  dirty: boolean;
  /**
   * Its commit is in flight, or the publish moment is playing before it hands
   * over. The holds may already be saved, and the wall is about to publish.
   */
  handingOver: boolean;
};

/**
 * What a way out does right now.
 *
 * `block` swallows the removal with no dialog. It covers the editor's save and
 * its publish moment: a dialog there would ask about work the climber has just
 * been told is saved, and whichever answer they gave would race the hand-over
 * (leave early and the wall is never published; leave late and the stale
 * answer pops the route mid-publish). The moment is short, so a second swipe
 * after it gets the ordinary question.
 *
 * `confirmDiscard` is the editor's unwritten changes; `confirm` is the generic
 * "the draft is kept" question; `leave` goes without asking.
 */
export type LeaveDecision = 'leave' | 'block' | 'confirm' | 'confirmDiscard';

export function leaveDecision(state: AddWallState, editor: EditorLeaveState): LeaveDecision {
  // The wall is published; all that is left is the bind and the dismiss, and
  // both of those ARE leaving. Said first and outright, not left to fall out of
  // `shouldConfirmLeave`: a detection flag left running, or a stale editor
  // ref, must never put a dialog — or a block — between the climber and the way
  // out of a step whose only control is that way out.
  if (state.step === 'done') return 'leave';
  if (state.step === 'review' && editor.handingOver) return 'block';
  // The look step's save is the same kind of moment: its success publishes.
  if (state.step === 'look' && state.lookSaving) return 'block';
  // And the details step's: its success publishes too.
  if (state.step === 'details' && state.details.saving) return 'block';
  if (state.step === 'review' && editor.dirty && !isBusy(state)) return 'confirmDiscard';
  return shouldConfirmLeave(state) ? 'confirm' : 'leave';
}

/** Where the flow stood when a leave dialog was put up. */
export type LeaveCheckpoint = {
  step: AddWallStep;
  publishRunning: boolean;
};

export function leaveCheckpoint(state: AddWallState): LeaveCheckpoint {
  return { step: state.step, publishRunning: state.publish.running };
}

/**
 * Whether a "Leave" pressed on a dialog may still go through.
 *
 * The dialog's answer is a closure over the flow as it was when it opened. If
 * the flow has since started publishing (the editor handed over under it, or
 * the auto-publish kicked off), popping the route now would strand the publish
 * the climber never agreed to abandon, so the answer is dropped and the next
 * swipe asks again about what is really happening.
 */
export function leaveStillApplies(askedAt: LeaveCheckpoint, state: AddWallState, editor: EditorLeaveState): boolean {
  if (leaveDecision(state, editor) === 'block') return false;
  const enteredPublish = askedAt.step !== state.step && (state.step === 'publish' || state.step === 'done');
  const publishStarted = state.publish.running && !askedAt.publishRunning;
  return !enteredPublish && !publishStarted;
}

export function addWallReducer(state: AddWallState, action: AddWallAction): AddWallState {
  switch (action.type) {
    case 'RESUME_CHECK_STARTED':
      // The full-screen wait: a reset building its clone, or a targeted open
      // reading the wall it names. A plain run never shows it.
      return { ...state, step: 'resuming', resumeCheck: 'pending' };

    case 'RESUME_DECLINED':
      // Either there was nothing to resume, or the climber chose to start over
      // and the old wall has been cleaned up. Either way this is a fresh wall.
      // A photo already picked behind the check stays: it is for the new wall,
      // and so is a crop the climber is in the middle of.
      return {
        ...state,
        step: state.step === 'resuming' ? 'photo' : state.step,
        resumeCheck: 'settled',
        wall: null,
        draft: null,
      };

    case 'RESUMED_AT_PHOTO':
      // The wall exists but no photo was ever adopted onto it, so the flow
      // rejoins at the photo. A photo picked while the check ran is kept: the
      // wall has none of its own, and so is a crop the climber is in (as for
      // `RESUME_DECLINED`). The busy flag is cleared either way: a resume must
      // never leave the flow stuck busy, with Back and leaving refused.
      return {
        ...state,
        step: state.step === 'adjust' ? 'adjust' : 'photo',
        resumeCheck: 'settled',
        wall: action.wall,
        draft: null,
        photoProcessing: false,
      };

    case 'RESUMED_AT_REVIEW': {
      // A draft version with a photo: the holds are the only thing left. No
      // second detector run — the candidates from the first pass were either
      // ruled on or are gone, and re-suggesting over saved holds would draw
      // every one of them twice. The editor loads the saved holds ON, so its
      // Publish goes straight through without a pointless edit.
      const resumedHolds = Math.max(0, action.savedHoldCount ?? 0);
      // A photo picked on this phone while the resume check ran is not the
      // draft's photo: drawn under the editor while it loads, it would show
      // the wrong wall. The upload's own retry (`planUploadRetry`) adopts a
      // draft made from THIS photo, so from `upload` it stays.
      const keepsLocalPhoto = state.step === 'upload';
      return {
        ...state,
        step: 'review',
        resumeCheck: 'settled',
        // A crop render the resume overtook has nothing left to land on.
        photoProcessing: false,
        photo: keepsLocalPhoto ? state.photo : null,
        anchors: keepsLocalPhoto ? state.anchors : null,
        anchorRejection: keepsLocalPhoto ? state.anchorRejection : null,
        wall: {
          wallUuid: action.draft.wallUuid,
          layoutId: action.draft.layoutId,
          viewerCanEdit: action.draft.viewerCanEdit,
        },
        draft: action.draft,
        detection: { outcome: 'idle', done: 0, total: 0, candidates: NO_CANDIDATES },
        savedHoldCount: resumedHolds,
      };
    }

    case 'PHOTO_PICKED':
      // A new photo invalidates the anchors — they were four points on the OTHER
      // picture — and resets the upload, whose attempts counted against a file
      // that is no longer the one being sent.
      return {
        ...state,
        photo: action.photo,
        anchors: null,
        anchorRejection: null,
        upload: { running: false, progress: null, error: null, attempts: 0, final: false },
      };

    case 'PHOTO_CONFIRMED':
      // Not while the resume check is out: going on would create a second wall
      // beside the one the climber may be about to be offered back.
      if (state.step !== 'photo' || !state.photo || state.resumeCheck === 'pending') return state;
      return { ...state, step: 'anchors' };

    case 'ADJUST_OPENED':
      // Only from the photo step, and only with a photo to adjust. Never once a
      // draft exists: its photo is already on the server, and the crop would
      // describe a picture nobody is going to upload.
      if (state.step !== 'photo' || !state.photo || state.draft) return state;
      return { ...state, step: 'adjust' };

    case 'PHOTO_PROCESSING_STARTED':
      if (state.step !== 'adjust') return state;
      return { ...state, photoProcessing: true };

    case 'PHOTO_ADJUSTED':
      // Back to the photo step with the edited file, which invalidates exactly
      // what a newly picked photo does. The anchors are CLEARED rather than
      // carried through the crop: a quarter turn changes which corner is the
      // top-left, and a quad mapped through it would come out in the wrong
      // order (a bow-tie the convexity check refuses at best, a mirrored wall
      // at worst).
      if (state.step !== 'adjust') return state;
      return {
        ...state,
        step: 'photo',
        photo: action.photo,
        photoProcessing: false,
        anchors: null,
        anchorRejection: null,
        upload: { running: false, progress: null, error: null, attempts: 0, final: false },
      };

    case 'PHOTO_PROCESSING_FAILED':
      // Stays on the crop step with the climber's edit intact, so Done can be
      // tried again or the edit cancelled.
      return state.photoProcessing ? { ...state, photoProcessing: false } : state;

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
        upload: { running: true, progress: null, error: null, attempts: state.upload.attempts + 1, final: false },
      };

    case 'UPLOAD_PROGRESS':
      if (!state.upload.running) return state;
      return { ...state, upload: { ...state.upload, progress: action.progress } };

    case 'UPLOAD_FAILED':
      // Stays on `upload` with the photo and the wall intact, so "Try again"
      // retries the upload alone rather than restarting the flow.
      return {
        ...state,
        step: 'upload',
        upload: { ...state.upload, running: false, error: action.message, final: action.final ?? false },
      };

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

    case 'REVIEW_COMMITTED':
      // The editor's commit saves the holds; background and hold lighting are
      // chosen next before publishing. Refused off the review step, and for an empty
      // wall — publishing a version with no holds creates a wall that cannot
      // hold a climb, and a look picked over no holds previews nothing.
      if (state.step !== 'review' || !(action.holdCount > 0)) return state;
      return {
        ...state,
        step: 'background',
        savedHoldCount: action.holdCount,
        publish: { running: false, error: null },
      };

    case 'BACKGROUND_CONFIRMED':
      if (state.step !== 'background') return state;
      return { ...state, step: 'look' };

    case 'LOOK_CONFIRMED':
      // The look is already stored on the wall by the time this lands (the
      // screen writes it, then confirms). Next is the details step, prefilled;
      // a reset has no details to ask about, so it lands on `publish`, which
      // starts the publish (the screen runs it from an effect). Refused off the
      // look step: a stray confirm must not skip the editor's own guard on an
      // empty wall.
      if (state.step !== 'look') return state;
      if (!state.skipsDetails) {
        return { ...state, step: 'details', lookSaving: false, details: { saving: false, error: null } };
      }
      return { ...state, step: 'publish', lookSaving: false, publish: { running: false, error: null } };

    case 'DETAILS_SAVE_STARTED':
      if (state.step !== 'details' || state.details.saving) return state;
      return { ...state, details: { saving: true, error: null } };

    case 'DETAILS_SAVE_FAILED':
      // Stays on the details step with every field as the climber left it, so
      // Save sends again exactly what did not land.
      if (state.step !== 'details') return state;
      return { ...state, details: { saving: false, error: action.message } };

    case 'DETAILS_SAVED':
      // Saved, or nothing changed: publishing is all that is left, and landing
      // on `publish` starts it. Refused off the details step for the reason
      // `LOOK_CONFIRMED` is refused off the look step.
      if (state.step !== 'details') return state;
      return {
        ...state,
        step: 'publish',
        details: { saving: false, error: null },
        publish: { running: false, error: null },
      };

    case 'LOOK_SAVE_STARTED':
      if (state.step !== 'look') return state;
      return { ...state, lookSaving: true };

    case 'LOOK_SAVE_FAILED':
      return state.lookSaving ? { ...state, lookSaving: false } : state;

    case 'PUBLISH_STARTED':
      // Only from the publish step: the details step (a reset's look step) is
      // the only way in, and a publish started anywhere else would skip it (and
      // the editor's guard on an empty wall). The screen's two callers both run
      // on this step.
      if (state.step !== 'publish') return state;
      return { ...state, publish: { running: true, error: null } };

    case 'PUBLISH_FAILED':
      // Back onto the publish step so the retry is reachable — including when
      // the failure was the BIND rather than the publish, which leaves
      // `published` latched and is why the retry does not re-publish.
      return { ...state, step: 'publish', publish: { running: false, error: action.message } };

    case 'PUBLISHED':
      // Also dispatched by a retry whose version had already published, so the
      // re-bind runs on `done` like the first one: on `publish` with `running`
      // set, its own dismiss would be held by the leave guard's busy dialog.
      return { ...state, step: 'done', published: true, publish: { running: false, error: null } };

    case 'BACK': {
      // Never interrupt a request: the callback would land on a step that is no
      // longer showing it, and a half-uploaded photo would be charged to the
      // wrong attempt.
      if (isBusy(state)) return state;
      const target = BACK_TARGET[state.step];
      if (!target) return state;
      // Backing out of `anchors` keeps them: the climber may be checking the
      // photo, not replacing it. Picking a new photo is what clears them. Out
      // of `details`, the fields stay as they were typed and only a stale
      // save error goes.
      if (state.step === 'details') return { ...state, step: target, details: { saving: false, error: null } };
      return { ...state, step: target };
    }

    default:
      return state;
  }
}
