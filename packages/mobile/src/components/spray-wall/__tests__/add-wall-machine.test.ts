import { describe, expect, it } from 'vitest';
import type { Quad } from '@boardsesh/spray-wall-geometry';
import {
  addWallReducer,
  hasUnfinishedWall,
  initialAddWallState,
  isBusy,
  leavingKeepsDraft,
  shouldConfirmLeave,
  type AddWallAction,
  type AddWallState,
  type CreatedWallDraft,
} from '../add-wall-machine';

const PHOTO = { uri: 'file:///wall.jpg', width: 2048, height: 1536, source: 'library' as const };
const OTHER_PHOTO = { uri: 'file:///other.jpg', width: 1024, height: 1024, source: 'camera' as const };

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

describe('addWallReducer — review and publish', () => {
  it('saving holds unlocks Done without leaving the editor', () => {
    const state = addWallReducer(atReview(), { type: 'HOLDS_SAVED', holdCount: 42 });
    expect(state.step).toBe('review');
    expect(state.hasSavedHolds).toBe(true);
    expect(state.savedHoldCount).toBe(42);
  });

  it('keeps Done unlocked after a save that only deleted holds', () => {
    // The summary reports what ONE save applied, so a correcting pass that only
    // removes holds writes zero. Gating on that count would re-lock a wall that
    // is finished.
    const state = run(
      [
        { type: 'HOLDS_SAVED', holdCount: 40 },
        { type: 'HOLDS_SAVED', holdCount: 0 },
      ],
      atReview(),
    );
    expect(state.hasSavedHolds).toBe(true);
    expect(addWallReducer(state, { type: 'REVIEW_DONE' }).step).toBe('publish');
  });

  it('refuses to publish a wall with no holds saved', () => {
    const state = atReview();
    expect(addWallReducer(state, { type: 'REVIEW_DONE' }).step).toBe('review');
  });

  it('moves to publish once holds exist', () => {
    const state = run([{ type: 'HOLDS_SAVED', holdCount: 12 }, { type: 'REVIEW_DONE' }], atReview());
    expect(state.step).toBe('publish');
    expect(state.savedHoldCount).toBe(12);
  });

  it('keeps the draft when publishing fails, so it can be retried', () => {
    const state = run(
      [
        { type: 'HOLDS_SAVED', holdCount: 12 },
        { type: 'REVIEW_DONE' },
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
        { type: 'HOLDS_SAVED', holdCount: 12 },
        { type: 'REVIEW_DONE' },
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
        { type: 'HOLDS_SAVED', holdCount: 1 },
        { type: 'REVIEW_DONE' },
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
        { type: 'HOLDS_SAVED', holdCount: 3 },
        { type: 'REVIEW_DONE' },
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
        { type: 'HOLDS_SAVED', holdCount: 3 },
        { type: 'REVIEW_DONE' },
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
        { type: 'HOLDS_SAVED', holdCount: 3 },
        { type: 'REVIEW_DONE' },
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
  it('unlocks Done without a gratuitous edit', () => {
    // The editor loads persisted holds as CLEAN state, so its own Save is
    // disabled (nothing is dirty). A Done gated on "this session saved
    // something" would leave a climber who saved and walked away unable to
    // publish at all.
    const state = addWallReducer(initialAddWallState(), {
      type: 'RESUMED_AT_REVIEW',
      draft: DRAFT,
      savedHoldCount: 42,
    });
    expect(state.hasSavedHolds).toBe(true);
    expect(state.savedHoldCount).toBe(42);
    expect(addWallReducer(state, { type: 'REVIEW_DONE' }).step).toBe('publish');
  });

  it('leaves Done locked for a draft with no holds on it yet', () => {
    const state = addWallReducer(initialAddWallState(), {
      type: 'RESUMED_AT_REVIEW',
      draft: DRAFT,
      savedHoldCount: 0,
    });
    expect(state.hasSavedHolds).toBe(false);
    expect(addWallReducer(state, { type: 'REVIEW_DONE' }).step).toBe('review');
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
    expect(shouldConfirmLeave(run([{ type: 'PUBLISH_STARTED' }]))).toBe(true);
  });

  it('asks once a draft exists, because only the editor knows what is unsaved', () => {
    expect(shouldConfirmLeave(atReview())).toBe(true);
  });

  it('stops asking once the wall is published', () => {
    const published = run(
      [
        { type: 'HOLDS_SAVED', holdCount: 1 },
        { type: 'REVIEW_DONE' },
        { type: 'PUBLISH_STARTED' },
        { type: 'PUBLISHED' },
      ],
      atReview(),
    );
    expect(shouldConfirmLeave(published)).toBe(false);
  });
});
