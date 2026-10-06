import { describe, expect, it } from 'vitest';
import type { Quad } from '@boardsesh/spray-wall-geometry';
import {
  addWallReducer,
  backLeavesFlow,
  hasUnfinishedWall,
  initialAddWallState,
  isBusy,
  leaveCheckpoint,
  leaveDecision,
  leaveStillApplies,
  leavingKeepsDraft,
  shouldConfirmLeave,
  type AddWallAction,
  type AddWallState,
  type CreatedWallDraft,
} from '../add-wall-machine';

/** A picked photo as the picker hands it back: its own base, no edit yet. */
function pickedPhoto(uri: string, width: number, height: number, source: 'library' | 'camera') {
  const base = { uri, width, height };
  return { ...base, base, original: { uri: `${uri}.heic`, longSide: 4032 }, edit: null, source };
}

const PHOTO = pickedPhoto('file:///wall.jpg', 2048, 1536, 'library');
const OTHER_PHOTO = pickedPhoto('file:///other.jpg', 1024, 1024, 'camera');

const DRAFT: CreatedWallDraft = {
  wallUuid: 'wall-1',
  layoutId: 9001,
  versionId: 'version-1',
  versionNumber: 1,
  viewerCanEdit: true,
};

/** A square, correctly ordered TL/TR/BR/BL quad. */
const SQUARE: Quad = [
  [100, 100],
  [900, 100],
  [900, 700],
  [100, 700],
];

/** The same four points with two swapped, so the outline crosses itself. */
const BOW_TIE: Quad = [
  [100, 100],
  [900, 100],
  [100, 700],
  [900, 700],
];

function run(actions: AddWallAction[], from: AddWallState = fresh()): AddWallState {
  return actions.reduce(addWallReducer, from);
}

/** A flow that has already answered "no, there is nothing to pick up". */
function fresh(): AddWallState {
  return addWallReducer(initialAddWallState(), { type: 'RESUME_DECLINED' });
}

/** The state a flow is in once the photo is chosen and the wall is on the server. */
function atReview(candidates: { cx: number; cy: number; r: number; confidence: number }[] = []): AddWallState {
  return run([
    { type: 'META_DONE' },
    { type: 'PHOTO_PICKED', photo: PHOTO },
    { type: 'PHOTO_CONFIRMED' },
    { type: 'ANCHORS_DONE' },
    { type: 'UPLOAD_STARTED' },
    { type: 'DRAFT_CREATED', draft: DRAFT },
    { type: 'DETECTION_STARTED' },
    { type: 'DETECTION_FINISHED', candidates },
  ]);
}

describe('addWallReducer — walking forwards', () => {
  it('starts by checking for a wall to pick up', () => {
    const state = initialAddWallState();
    expect(state.step).toBe('resuming');
    expect(state.photo).toBeNull();
    expect(state.wall).toBeNull();
    expect(state.draft).toBeNull();
    expect(state.published).toBe(false);
  });

  it('runs meta → photo → anchors → upload', () => {
    const state = run([{ type: 'META_DONE' }, { type: 'PHOTO_PICKED', photo: PHOTO }, { type: 'PHOTO_CONFIRMED' }]);
    expect(state.step).toBe('anchors');
    expect(addWallReducer(state, { type: 'ANCHORS_DONE' }).step).toBe('upload');
  });

  it('will not leave the photo step with no photo', () => {
    const state = run([{ type: 'META_DONE' }, { type: 'PHOTO_CONFIRMED' }]);
    expect(state.step).toBe('photo');
  });

  it('lands in the editor once detection finishes, carrying the candidates', () => {
    const state = atReview([{ cx: 10, cy: 20, r: 5, confidence: 0.8 }]);
    expect(state.step).toBe('review');
    expect(state.detection.outcome).toBe('done');
    expect(state.detection.candidates).toHaveLength(1);
  });
});

describe('addWallReducer — the anchor quad', () => {
  it('accepts a convex quad', () => {
    const state = addWallReducer(fresh(), { type: 'ANCHORS_SET', anchors: SQUARE });
    expect(state.anchors).toEqual(SQUARE);
    expect(state.anchorRejection).toBeNull();
  });

  it('refuses a quad that crosses itself, and keeps the last good one', () => {
    const good = addWallReducer(fresh(), { type: 'ANCHORS_SET', anchors: SQUARE });
    const rejected = addWallReducer(good, { type: 'ANCHORS_SET', anchors: BOW_TIE });
    expect(rejected.anchorRejection).toBe('not-convex');
    // The bow-tie is NOT stored: a crossed quad maps the wall inside out, and the
    // server's fallback for a degenerate one is the identity matrix — so storing
    // it would silently put every hold somewhere plausible and wrong.
    expect(rejected.anchors).toEqual(SQUARE);
  });

  it('clears the rejection once a good quad arrives', () => {
    const state = run([
      { type: 'ANCHORS_SET', anchors: BOW_TIE },
      { type: 'ANCHORS_SET', anchors: SQUARE },
    ]);
    expect(state.anchorRejection).toBeNull();
    expect(state.anchors).toEqual(SQUARE);
  });

  it('skipping leaves no anchors at all, which is the photo-frame case', () => {
    const state = run([
      { type: 'META_DONE' },
      { type: 'PHOTO_PICKED', photo: PHOTO },
      { type: 'PHOTO_CONFIRMED' },
      { type: 'ANCHORS_DONE' },
    ]);
    expect(state.anchors).toBeNull();
    expect(state.step).toBe('upload');
  });
});

describe('addWallReducer — going back', () => {
  it('keeps the wall meta and the photo when backing out of the anchors', () => {
    const state = run([
      { type: 'META_DONE' },
      { type: 'PHOTO_PICKED', photo: PHOTO },
      { type: 'PHOTO_CONFIRMED' },
      { type: 'ANCHORS_SET', anchors: SQUARE },
      { type: 'BACK' },
    ]);
    expect(state.step).toBe('photo');
    expect(state.photo).toEqual(PHOTO);
    // Backing up is not replacing: the climber may just be checking the photo.
    expect(state.anchors).toEqual(SQUARE);
  });

  it('drops the anchors when a DIFFERENT photo is picked', () => {
    const state = run([
      { type: 'META_DONE' },
      { type: 'PHOTO_PICKED', photo: PHOTO },
      { type: 'PHOTO_CONFIRMED' },
      { type: 'ANCHORS_SET', anchors: SQUARE },
      { type: 'BACK' },
      { type: 'PHOTO_PICKED', photo: OTHER_PHOTO },
    ]);
    expect(state.photo).toEqual(OTHER_PHOTO);
    expect(state.anchors).toBeNull();
  });

  it('refuses to move while a request is in flight', () => {
    const uploading = run([
      { type: 'META_DONE' },
      { type: 'PHOTO_PICKED', photo: PHOTO },
      { type: 'PHOTO_CONFIRMED' },
      { type: 'ANCHORS_DONE' },
      { type: 'UPLOAD_STARTED' },
    ]);
    expect(isBusy(uploading)).toBe(true);
    expect(addWallReducer(uploading, { type: 'BACK' })).toBe(uploading);
  });

  it('has nowhere to go back to from the review step', () => {
    const state = atReview();
    expect(addWallReducer(state, { type: 'BACK' }).step).toBe('review');
  });

  it('has nowhere to go back to from detection either, once a draft exists', () => {
    // Backing into `photo` from here would offer a second photo for a draft that
    // already has one, which `runUpload` declines outright — so the step would sit
    // doing nothing, which is worse than having no way back.
    const detecting = run([{ type: 'DRAFT_CREATED', draft: DRAFT }]);
    expect(detecting.step).toBe('detect');
    expect(addWallReducer(detecting, { type: 'BACK' }).step).toBe('detect');
  });
});

describe('addWallReducer — a failed upload', () => {
  it('stays on the upload step with the photo and the error', () => {
    const state = run([
      { type: 'META_DONE' },
      { type: 'PHOTO_PICKED', photo: PHOTO },
      { type: 'PHOTO_CONFIRMED' },
      { type: 'ANCHORS_DONE' },
      { type: 'UPLOAD_STARTED' },
      { type: 'UPLOAD_FAILED', message: 'no signal' },
    ]);
    expect(state.step).toBe('upload');
    expect(state.upload.error).toBe('no signal');
    expect(state.upload.running).toBe(false);
    expect(state.photo).toEqual(PHOTO);
  });

  it('counts attempts so a retry is distinguishable from a first try', () => {
    const state = run([
      { type: 'UPLOAD_STARTED' },
      { type: 'UPLOAD_FAILED', message: 'no signal' },
      { type: 'UPLOAD_STARTED' },
    ]);
    expect(state.upload.attempts).toBe(2);
    expect(state.upload.error).toBeNull();
  });

  it('ignores progress that arrives after the upload stopped', () => {
    const settled = run([{ type: 'UPLOAD_STARTED' }, { type: 'UPLOAD_FAILED', message: 'no signal' }]);
    expect(addWallReducer(settled, { type: 'UPLOAD_PROGRESS', progress: 0.5 })).toBe(settled);
  });

  it('resets the attempt count when a new photo replaces the one that failed', () => {
    const state = run([
      { type: 'UPLOAD_STARTED' },
      { type: 'UPLOAD_FAILED', message: 'no signal' },
      { type: 'PHOTO_PICKED', photo: OTHER_PHOTO },
    ]);
    expect(state.upload.attempts).toBe(0);
    expect(state.upload.error).toBeNull();
  });
});

describe('addWallReducer — no model on this phone', () => {
  it('goes straight to the editor with nothing to review', () => {
    const state = run([
      { type: 'DRAFT_CREATED', draft: DRAFT },
      { type: 'DETECTION_STARTED' },
      { type: 'DETECTION_UNAVAILABLE' },
    ]);
    expect(state.step).toBe('review');
    expect(state.detection.outcome).toBe('unavailable');
    expect(state.detection.candidates).toHaveLength(0);
    // The draft is what the editor needs; a missing model must not cost it.
    expect(state.draft).toEqual(DRAFT);
  });

  it('treats a detector that blew up the same way, but says so differently', () => {
    const state = run([
      { type: 'DRAFT_CREATED', draft: DRAFT },
      { type: 'DETECTION_STARTED' },
      { type: 'DETECTION_FAILED' },
    ]);
    expect(state.step).toBe('review');
    expect(state.detection.outcome).toBe('failed');
  });

  it('ignores progress from a run that already settled', () => {
    const settled = run([{ type: 'DETECTION_STARTED' }, { type: 'DETECTION_UNAVAILABLE' }]);
    expect(addWallReducer(settled, { type: 'DETECTION_PROGRESS', done: 2, total: 4 })).toBe(settled);
  });
});

describe('addWallReducer — review, look and publish', () => {
  it('a commit from the editor moves on to the look step, not straight to publish', () => {
    const state = addWallReducer(atReview(), { type: 'REVIEW_COMMITTED', holdCount: 42 });
    expect(state.step).toBe('look');
    expect(state.savedHoldCount).toBe(42);
    expect(state.publish).toEqual({ running: false, error: null });
  });

  it('refuses to publish a wall with no holds', () => {
    const state = atReview();
    expect(addWallReducer(state, { type: 'REVIEW_COMMITTED', holdCount: 0 })).toBe(state);
  });

  it('ignores a commit that arrives off the review step', () => {
    const state = run([{ type: 'META_DONE' }]);
    expect(addWallReducer(state, { type: 'REVIEW_COMMITTED', holdCount: 5 })).toBe(state);
  });

  it('moves to publish once holds exist and the look is confirmed', () => {
    const state = run([{ type: 'REVIEW_COMMITTED', holdCount: 12 }, { type: 'LOOK_CONFIRMED' }], atReview());
    expect(state.step).toBe('publish');
    expect(state.savedHoldCount).toBe(12);
  });

  it('keeps the draft when publishing fails, so it can be retried', () => {
    const state = run(
      [
        { type: 'REVIEW_COMMITTED', holdCount: 12 },
        { type: 'LOOK_CONFIRMED' },
        { type: 'PUBLISH_STARTED' },
        { type: 'PUBLISH_FAILED', message: 'server said no' },
      ],
      atReview(),
    );
    expect(state.step).toBe('publish');
    expect(state.publish.error).toBe('server said no');
    expect(state.draft).toEqual(DRAFT);
  });

  it('finishes on done', () => {
    const state = run(
      [
        { type: 'REVIEW_COMMITTED', holdCount: 12 },
        { type: 'LOOK_CONFIRMED' },
        { type: 'PUBLISH_STARTED' },
        { type: 'PUBLISHED' },
      ],
      atReview(),
    );
    expect(state.step).toBe('done');
    expect(state.publish.running).toBe(false);
  });
});

describe('leavingKeepsDraft', () => {
  it('is false before anything reaches the server', () => {
    expect(leavingKeepsDraft(run([{ type: 'META_DONE' }, { type: 'PHOTO_PICKED', photo: PHOTO }]))).toBe(false);
  });

  it('is true once the wall and its draft version exist', () => {
    expect(leavingKeepsDraft(atReview())).toBe(true);
  });

  it('is false once the wall is published — there is no draft left to keep', () => {
    const published = run(
      [
        { type: 'REVIEW_COMMITTED', holdCount: 1 },
        { type: 'LOOK_CONFIRMED' },
        { type: 'PUBLISH_STARTED' },
        { type: 'PUBLISHED' },
      ],
      atReview(),
    );
    expect(leavingKeepsDraft(published)).toBe(false);
  });
});

describe('addWallReducer — picking up an abandoned wall', () => {
  const WALL = { wallUuid: 'wall-1', layoutId: 9001, viewerCanEdit: true };

  it('declining the resume starts a fresh wall', () => {
    const state = addWallReducer(initialAddWallState(), { type: 'RESUME_DECLINED' });
    expect(state.step).toBe('meta');
    expect(state.wall).toBeNull();
    expect(state.draft).toBeNull();
  });

  it('resuming a bare wall rejoins at the photo and REUSES the wall', () => {
    const state = addWallReducer(initialAddWallState(), { type: 'RESUMED_AT_PHOTO', wall: WALL });
    expect(state.step).toBe('photo');
    // The whole point: the meta step never runs again, and nothing downstream
    // may call createSprayWall for a wall that already exists.
    expect(state.wall).toEqual(WALL);
    expect(state.draft).toBeNull();
  });

  it('resuming a draft with a photo rejoins at the editor with no candidates', () => {
    const state = addWallReducer(initialAddWallState(), { type: 'RESUMED_AT_REVIEW', draft: DRAFT });
    expect(state.step).toBe('review');
    expect(state.draft).toEqual(DRAFT);
    expect(state.wall).toEqual(WALL);
    // No second detector pass: the first run's candidates were either ruled on
    // or are gone, and re-suggesting over saved holds would draw them twice.
    expect(state.detection.candidates).toHaveLength(0);
    expect(state.detection.outcome).toBe('idle');
  });

  it('knows a created wall is unfinished until it publishes', () => {
    const created = run([{ type: 'WALL_CREATED', wall: WALL }]);
    expect(hasUnfinishedWall(created)).toBe(true);

    const published = run(
      [
        { type: 'REVIEW_COMMITTED', holdCount: 3 },
        { type: 'LOOK_CONFIRMED' },
        { type: 'PUBLISH_STARTED' },
        { type: 'PUBLISHED' },
      ],
      atReview(),
    );
    expect(hasUnfinishedWall(published)).toBe(false);
  });

  it('records the wall before the draft, so a failed upload still knows about it', () => {
    const state = run([
      { type: 'WALL_CREATED', wall: WALL },
      { type: 'UPLOAD_FAILED', message: 'no signal' },
    ]);
    expect(state.wall).toEqual(WALL);
    expect(state.draft).toBeNull();
    expect(hasUnfinishedWall(state)).toBe(true);
  });
});

describe('addWallReducer — publishing is latched separately from binding', () => {
  function published(): AddWallState {
    return run(
      [
        { type: 'REVIEW_COMMITTED', holdCount: 3 },
        { type: 'LOOK_CONFIRMED' },
        { type: 'PUBLISH_STARTED' },
        { type: 'PUBLISHED' },
      ],
      atReview(),
    );
  }

  it('latches `published` so a retry cannot re-publish', () => {
    const state = published();
    expect(state.published).toBe(true);

    // The BIND failed, not the publish. The retry has to bind again and must not
    // call publishSprayWallVersion, which refuses an already-published version.
    const bindFailed = addWallReducer(state, { type: 'PUBLISH_FAILED', message: 'could not switch board' });
    expect(bindFailed.published).toBe(true);
    expect(bindFailed.step).toBe('publish');
    expect(bindFailed.publish.error).toBe('could not switch board');
  });

  it('is not latched when the publish itself failed', () => {
    const state = run(
      [
        { type: 'REVIEW_COMMITTED', holdCount: 3 },
        { type: 'LOOK_CONFIRMED' },
        { type: 'PUBLISH_STARTED' },
        { type: 'PUBLISH_FAILED', message: 'server said no' },
      ],
      atReview(),
    );
    expect(state.published).toBe(false);
    expect(state.step).toBe('publish');
  });
});

describe('addWallReducer — a resumed draft that already has holds', () => {
  it('publishes without a gratuitous edit', () => {
    // The editor loads persisted holds ON and clean, so its commit has nothing to
    // write and reports the wall's count straight away.
    const state = addWallReducer(initialAddWallState(), {
      type: 'RESUMED_AT_REVIEW',
      draft: DRAFT,
      savedHoldCount: 42,
    });
    expect(state.savedHoldCount).toBe(42);
    const committed = addWallReducer(state, { type: 'REVIEW_COMMITTED', holdCount: 42 });
    // A resumed wall still gets its look asked — the resume lands on review, and
    // the look is only ever stored by this step.
    expect(committed.step).toBe('look');
    expect(addWallReducer(committed, { type: 'LOOK_CONFIRMED' }).step).toBe('publish');
  });

  it('never counts a negative stored total', () => {
    const state = addWallReducer(initialAddWallState(), {
      type: 'RESUMED_AT_REVIEW',
      draft: DRAFT,
      savedHoldCount: -3,
    });
    expect(state.savedHoldCount).toBe(0);
  });
});

describe('shouldConfirmLeave', () => {
  // Every way out asks the same question — the footer's Back, the header's back
  // button, the iOS gesture and Android's Back key — because a climber asked by
  // one and silently dropped by another has learned the app does not mean it.
  it('does not ask before anything has been written', () => {
    expect(shouldConfirmLeave(fresh())).toBe(false);
    expect(shouldConfirmLeave(run([{ type: 'META_DONE' }, { type: 'PHOTO_PICKED', photo: PHOTO }]))).toBe(false);
  });

  it('asks while a request is in flight', () => {
    expect(shouldConfirmLeave(run([{ type: 'UPLOAD_STARTED' }]))).toBe(true);
    expect(shouldConfirmLeave(run([{ type: 'DETECTION_STARTED' }]))).toBe(true);
    const publishing = run(
      [{ type: 'REVIEW_COMMITTED', holdCount: 3 }, { type: 'LOOK_CONFIRMED' }, { type: 'PUBLISH_STARTED' }],
      atReview(),
    );
    expect(publishing.publish.running).toBe(true);
    expect(shouldConfirmLeave(publishing)).toBe(true);
  });

  it('asks once a draft exists, because only the editor knows what is unsaved', () => {
    expect(shouldConfirmLeave(atReview())).toBe(true);
  });

  it('stops asking once the wall is published', () => {
    const published = run(
      [
        { type: 'REVIEW_COMMITTED', holdCount: 1 },
        { type: 'LOOK_CONFIRMED' },
        { type: 'PUBLISH_STARTED' },
        { type: 'PUBLISHED' },
      ],
      atReview(),
    );
    expect(shouldConfirmLeave(published)).toBe(false);
  });
});

const EDITOR_IDLE = { dirty: false, handingOver: false };
const EDITOR_DIRTY = { dirty: true, handingOver: false };
const EDITOR_HANDING_OVER = { dirty: false, handingOver: true };

describe('leaveDecision', () => {
  it('swallows every way out while the editor saves or plays its publish moment', () => {
    expect(leaveDecision(atReview(), EDITOR_HANDING_OVER)).toBe('block');
    // The save is still in flight, so the editor is still dirty too: no discard dialog.
    expect(leaveDecision(atReview(), { dirty: true, handingOver: true })).toBe('block');
  });

  it('asks about unwritten hold changes on the review step', () => {
    expect(leaveDecision(atReview(), EDITOR_DIRTY)).toBe('confirmDiscard');
  });

  it('asks the generic question once the editor has nothing unsaved', () => {
    expect(leaveDecision(atReview(), EDITOR_IDLE)).toBe('confirm');
  });

  it('always lets the climber out of done, whatever stale flags the run left behind', () => {
    const done = run(
      [
        { type: 'REVIEW_COMMITTED', holdCount: 3 },
        { type: 'LOOK_CONFIRMED' },
        { type: 'PUBLISH_STARTED' },
        { type: 'PUBLISHED' },
      ],
      atReview(),
    );
    expect(leaveDecision(done, EDITOR_IDLE)).toBe('leave');
    expect(leaveDecision(done, { dirty: true, handingOver: true })).toBe('leave');
    // A detection flag that never cleared would otherwise ask first.
    const detectionStuck = { ...done, detection: { ...done.detection, outcome: 'running' as const } };
    expect(leaveDecision(detectionStuck, EDITOR_IDLE)).toBe('leave');
  });

  it('re-binds on done when a retry finds the version already published', () => {
    const failedBind = run(
      [
        { type: 'REVIEW_COMMITTED', holdCount: 3 },
        { type: 'LOOK_CONFIRMED' },
        { type: 'PUBLISH_STARTED' },
        { type: 'PUBLISHED' },
        { type: 'PUBLISH_FAILED', message: 'bind stalled' },
      ],
      atReview(),
    );
    expect(failedBind.step).toBe('publish');
    expect(failedBind.published).toBe(true);

    const retrying = run([{ type: 'PUBLISH_STARTED' }, { type: 'PUBLISHED' }], failedBind);
    expect(retrying.step).toBe('done');
    expect(retrying.publish).toEqual({ running: false, error: null });
    expect(leaveDecision(retrying, EDITOR_IDLE)).toBe('leave');
  });

  it('only blocks on the review step: a stale flag cannot trap the climber elsewhere', () => {
    const publishing = run(
      [{ type: 'REVIEW_COMMITTED', holdCount: 3 }, { type: 'LOOK_CONFIRMED' }, { type: 'PUBLISH_STARTED' }],
      atReview(),
    );
    expect(leaveDecision(publishing, EDITOR_HANDING_OVER)).toBe('confirm');
    expect(leaveDecision(fresh(), EDITOR_HANDING_OVER)).toBe('leave');
  });
});

describe('leaveStillApplies', () => {
  it('lets a Leave through when nothing moved under the dialog', () => {
    const state = atReview();
    expect(leaveStillApplies(leaveCheckpoint(state), state, EDITOR_IDLE)).toBe(true);
  });

  it('drops a Leave pressed after the look step handed over to the publish step', () => {
    const atLook = run([{ type: 'REVIEW_COMMITTED', holdCount: 3 }], atReview());
    const asked = leaveCheckpoint(atLook);
    const handedOver = run([{ type: 'LOOK_CONFIRMED' }], atLook);
    expect(handedOver.step).toBe('publish');
    expect(leaveStillApplies(asked, handedOver, EDITOR_IDLE)).toBe(false);
  });

  it('lets a Leave through when the editor only handed over to the look step', () => {
    // Nothing is publishing yet: the holds are saved on the draft and the look
    // has not been asked. Leaving here keeps the draft, exactly as it would from
    // the look step itself, so there is no publish for the answer to strand.
    const asked = leaveCheckpoint(atReview());
    const handedOver = run([{ type: 'REVIEW_COMMITTED', holdCount: 3 }], atReview());
    expect(handedOver.step).toBe('look');
    expect(leaveStillApplies(asked, handedOver, EDITOR_IDLE)).toBe(true);
  });

  it('drops a Leave pressed after the auto-publish started', () => {
    const committed = run([{ type: 'REVIEW_COMMITTED', holdCount: 3 }, { type: 'LOOK_CONFIRMED' }], atReview());
    const asked = leaveCheckpoint(committed);
    const publishing = run([{ type: 'PUBLISH_STARTED' }], committed);
    expect(leaveStillApplies(asked, publishing, EDITOR_IDLE)).toBe(false);
  });

  it('drops a Leave pressed once the editor starts handing over', () => {
    const state = atReview();
    expect(leaveStillApplies(leaveCheckpoint(state), state, EDITOR_HANDING_OVER)).toBe(false);
  });

  it('keeps a Leave the climber agreed to mid-publish', () => {
    const publishing = run(
      [{ type: 'REVIEW_COMMITTED', holdCount: 3 }, { type: 'LOOK_CONFIRMED' }, { type: 'PUBLISH_STARTED' }],
      atReview(),
    );
    expect(leaveStillApplies(leaveCheckpoint(publishing), publishing, EDITOR_IDLE)).toBe(true);
  });
});

describe('addWallReducer — the look step', () => {
  function atLook(): AddWallState {
    return run([{ type: 'REVIEW_COMMITTED', holdCount: 7 }], atReview());
  }

  it('is where a review commit lands, with the draft and the hold count intact', () => {
    const state = atLook();
    expect(state.step).toBe('look');
    expect(state.draft).toEqual(DRAFT);
    expect(state.savedHoldCount).toBe(7);
    expect(state.published).toBe(false);
  });

  it('moves on to publish when the look is confirmed', () => {
    const state = addWallReducer(atLook(), { type: 'LOOK_CONFIRMED' });
    expect(state.step).toBe('publish');
    expect(state.publish).toEqual({ running: false, error: null });
    expect(state.published).toBe(false);
  });

  it('ignores a confirm that arrives off the look step', () => {
    // A stray confirm must not skip the editor and its empty-wall guard.
    const review = atReview();
    expect(addWallReducer(review, { type: 'LOOK_CONFIRMED' })).toBe(review);
    const meta = run([{ type: 'META_DONE' }]);
    expect(addWallReducer(meta, { type: 'LOOK_CONFIRMED' })).toBe(meta);
  });

  it('has nowhere to go back to — the holds are committed, so back means leaving', () => {
    const state = atLook();
    expect(addWallReducer(state, { type: 'BACK' })).toBe(state);
  });

  it('keeps the draft if the climber leaves here, and asks before they do', () => {
    const state = atLook();
    expect(leavingKeepsDraft(state)).toBe(true);
    expect(hasUnfinishedWall(state)).toBe(true);
    expect(shouldConfirmLeave(state)).toBe(true);
    // A hand-over flag left over from the editor cannot block the look step.
    expect(leaveDecision(state, EDITOR_HANDING_OVER)).toBe('confirm');
    expect(leaveDecision(state, EDITOR_IDLE)).toBe('confirm');
  });

  it('is the only way from review to publish', () => {
    const state = run(
      [
        { type: 'REVIEW_COMMITTED', holdCount: 4 },
        { type: 'LOOK_CONFIRMED' },
        { type: 'PUBLISH_STARTED' },
        { type: 'PUBLISHED' },
      ],
      atReview(),
    );
    expect(state.step).toBe('done');
    expect(state.published).toBe(true);

    // Without the look step's confirm, a publish cannot start at all.
    const review = atReview();
    expect(addWallReducer(review, { type: 'PUBLISH_STARTED' })).toBe(review);
    const look = atLook();
    expect(addWallReducer(look, { type: 'PUBLISH_STARTED' })).toBe(look);
  });

  it('blocks every way out while the look is saving, because its success publishes', () => {
    const saving = addWallReducer(atLook(), { type: 'LOOK_SAVE_STARTED' });
    expect(saving.lookSaving).toBe(true);
    expect(isBusy(saving)).toBe(true);
    expect(leaveDecision(saving, EDITOR_IDLE)).toBe('block');
    expect(addWallReducer(saving, { type: 'BACK' })).toBe(saving);
  });

  it('drops a Leave answered on a dialog the save started under', () => {
    const asked = leaveCheckpoint(atLook());
    const saving = addWallReducer(atLook(), { type: 'LOOK_SAVE_STARTED' });
    expect(leaveStillApplies(asked, saving, EDITOR_IDLE)).toBe(false);
  });

  it('asks the ordinary question again once a save fails, and clears the flag on confirm', () => {
    const failed = run([{ type: 'LOOK_SAVE_STARTED' }, { type: 'LOOK_SAVE_FAILED' }], atLook());
    expect(failed.lookSaving).toBe(false);
    expect(leaveDecision(failed, EDITOR_IDLE)).toBe('confirm');

    const confirmed = run([{ type: 'LOOK_SAVE_STARTED' }, { type: 'LOOK_CONFIRMED' }], atLook());
    expect(confirmed.step).toBe('publish');
    expect(confirmed.lookSaving).toBe(false);
  });

  it('ignores a save starting off the look step', () => {
    const review = atReview();
    expect(addWallReducer(review, { type: 'LOOK_SAVE_STARTED' })).toBe(review);
  });
});

describe('backLeavesFlow — what the footer Back does', () => {
  it('leaves from the look step instead of stepping back into the editor', () => {
    const atLook = run([{ type: 'REVIEW_COMMITTED', holdCount: 2 }], atReview());
    expect(backLeavesFlow(atLook)).toBe(true);
  });

  it('leaves from every step past the draft, and from the first step', () => {
    expect(backLeavesFlow(fresh())).toBe(true); // meta
    expect(backLeavesFlow(atReview())).toBe(true);
    expect(
      backLeavesFlow(run([{ type: 'REVIEW_COMMITTED', holdCount: 2 }, { type: 'LOOK_CONFIRMED' }], atReview())),
    ).toBe(true);
  });

  it('steps back inside the flow before a draft exists', () => {
    expect(backLeavesFlow(run([{ type: 'META_DONE' }]))).toBe(false); // photo
    expect(
      backLeavesFlow(run([{ type: 'META_DONE' }, { type: 'PHOTO_PICKED', photo: PHOTO }, { type: 'PHOTO_CONFIRMED' }])),
    ).toBe(false); // anchors
  });
});

describe('addWallReducer — crop or rotate', () => {
  const EDITED = {
    ...PHOTO,
    uri: 'file:///wall-edited.jpg',
    width: 1500,
    height: 1800,
    edit: { quarterTurns: 1 as const, crop: { left: 0.1, top: 0, right: 0.9, bottom: 1 } },
  };

  function atPhoto(): AddWallState {
    return run([{ type: 'META_DONE' }, { type: 'PHOTO_PICKED', photo: PHOTO }]);
  }

  it('opens only from the photo step, and only with a photo', () => {
    expect(run([{ type: 'ADJUST_OPENED' }], atPhoto()).step).toBe('adjust');
    expect(run([{ type: 'META_DONE' }, { type: 'ADJUST_OPENED' }]).step).toBe('photo');
    expect(run([{ type: 'PHOTO_CONFIRMED' }, { type: 'ADJUST_OPENED' }], atPhoto()).step).toBe('anchors');
  });

  it('goes back to the photo on Back, with the photo as it was', () => {
    const state = run([{ type: 'ADJUST_OPENED' }, { type: 'BACK' }], atPhoto());
    expect(state.step).toBe('photo');
    expect(state.photo).toEqual(PHOTO);
  });

  it('clears the corners when the edit lands, because a turn moves the top-left', () => {
    const withCorners = run(
      [{ type: 'PHOTO_CONFIRMED' }, { type: 'ANCHORS_SET', anchors: SQUARE }, { type: 'BACK' }],
      atPhoto(),
    );
    expect(withCorners.anchors).toEqual(SQUARE);

    const state = run(
      [{ type: 'ADJUST_OPENED' }, { type: 'PHOTO_PROCESSING_STARTED' }, { type: 'PHOTO_ADJUSTED', photo: EDITED }],
      withCorners,
    );
    expect(state.step).toBe('photo');
    expect(state.photo).toEqual(EDITED);
    expect(state.anchors).toBeNull();
    expect(state.anchorRejection).toBeNull();
    expect(state.photoProcessing).toBe(false);
    expect(state.upload.attempts).toBe(0);
  });

  it('holds Back and asks before leaving while the edit renders', () => {
    const rendering = run([{ type: 'ADJUST_OPENED' }, { type: 'PHOTO_PROCESSING_STARTED' }], atPhoto());
    expect(isBusy(rendering)).toBe(true);
    expect(shouldConfirmLeave(rendering)).toBe(true);
    expect(run([{ type: 'BACK' }], rendering).step).toBe('adjust');
  });

  it('stays on the crop step when the render fails, and lets Back through again', () => {
    const failed = run(
      [{ type: 'ADJUST_OPENED' }, { type: 'PHOTO_PROCESSING_STARTED' }, { type: 'PHOTO_PROCESSING_FAILED' }],
      atPhoto(),
    );
    expect(failed.step).toBe('adjust');
    expect(failed.photoProcessing).toBe(false);
    expect(failed.photo).toEqual(PHOTO);
    expect(run([{ type: 'BACK' }], failed).step).toBe('photo');
  });

  it('ignores an edit that lands anywhere but the crop step', () => {
    expect(run([{ type: 'PHOTO_ADJUSTED', photo: EDITED }], atPhoto()).photo).toEqual(PHOTO);
    expect(run([{ type: 'PHOTO_PROCESSING_STARTED' }], atPhoto()).photoProcessing).toBe(false);
  });

  it('is not offered once a draft has adopted the photo', () => {
    const uploaded = run([
      { type: 'META_DONE' },
      { type: 'PHOTO_PICKED', photo: PHOTO },
      { type: 'PHOTO_CONFIRMED' },
      { type: 'ANCHORS_DONE' },
      { type: 'UPLOAD_STARTED' },
      { type: 'DRAFT_CREATED', draft: DRAFT },
    ]);
    expect(run([{ type: 'ADJUST_OPENED' }], { ...uploaded, step: 'photo' }).step).toBe('photo');
  });
});
