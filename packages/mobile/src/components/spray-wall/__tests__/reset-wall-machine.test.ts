import { describe, expect, it } from 'vitest';
import type { Quad } from '@boardsesh/spray-wall-geometry';
import {
  anchorsAreReady,
  initialResetWallState,
  isBusy,
  leavingKeepsDraft,
  resetBackAction,
  resetWallReducer,
  shouldConfirmLeave,
  type ResetDraft,
  type ResetWallAction,
  type ResetWallState,
} from '../reset-wall-machine';

const PHOTO = { uri: 'file:///wall-v2.jpg', width: 2048, height: 1536, source: 'library' as const };
const OTHER_PHOTO = { uri: 'file:///wall-v2b.jpg', width: 1024, height: 1024, source: 'camera' as const };

const DRAFT: ResetDraft = { versionId: 'version-2', versionNumber: 2, photoWidth: 2048, photoHeight: 1536 };

/** A square, correctly ordered TL/TR/BR/BL quad. */
const SQUARE: Quad = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];

/** The same four points with two swapped: a bow tie, whose homography is inside out. */
const BOW_TIE: Quad = [
  [0, 0],
  [100, 0],
  [0, 100],
  [100, 100],
];

function run(state: ResetWallState, ...actions: ResetWallAction[]): ResetWallState {
  return actions.reduce(resetWallReducer, state);
}

/** A state parked on the anchors step with a photo chosen. */
function atAnchors(): ResetWallState {
  return run(initialResetWallState(), { type: 'PHOTO_PICKED', photo: PHOTO }, { type: 'PHOTO_CONFIRMED' });
}

describe('resetWallReducer — the anchors gate', () => {
  // THE test. A reset with no anchors stores the identity homography, which
  // asserts that the new photograph has the same crop and framing as version 1's.
  // No phone honours that, so the detections arrive labelled with coordinates
  // from another picture and the matcher reports the whole wall gone. The server
  // refuses it twice over; this gate is what stops a climber uploading a
  // photograph to be told so.
  it('refuses to leave the anchors step with no corners', () => {
    const state = atAnchors();
    expect(anchorsAreReady(state)).toBe(false);
    expect(run(state, { type: 'ANCHORS_DONE' }).step).toBe('anchors');
  });

  it('refuses to leave with corners that cross over each other', () => {
    const state = run(atAnchors(), { type: 'ANCHORS_SET', anchors: BOW_TIE });
    expect(state.anchorRejection).toBe('not-convex');
    expect(state.anchors).toBeNull();
    expect(anchorsAreReady(state)).toBe(false);
    expect(run(state, { type: 'ANCHORS_DONE' }).step).toBe('anchors');
  });

  it('moves on once four usable corners are set', () => {
    const state = run(atAnchors(), { type: 'ANCHORS_SET', anchors: SQUARE });
    expect(anchorsAreReady(state)).toBe(true);
    expect(run(state, { type: 'ANCHORS_DONE' }).step).toBe('upload');
  });

  it('locks the gate again when the corners are cleared', () => {
    const state = run(atAnchors(), { type: 'ANCHORS_SET', anchors: SQUARE }, { type: 'ANCHORS_CLEARED' });
    expect(anchorsAreReady(state)).toBe(false);
    expect(run(state, { type: 'ANCHORS_DONE' }).step).toBe('anchors');
  });

  it('drops the corners when a different photo is chosen — they described the other picture', () => {
    const state = run(
      atAnchors(),
      { type: 'ANCHORS_SET', anchors: SQUARE },
      { type: 'PHOTO_PICKED', photo: OTHER_PHOTO },
    );
    expect(state.anchors).toBeNull();
    expect(anchorsAreReady(state)).toBe(false);
  });
});

describe('resetWallReducer — the rest of the flow', () => {
  it('starts on the photo step: the wall already has a name, an angle and a visibility', () => {
    expect(initialResetWallState().step).toBe('photo');
  });

  it('will not confirm a photo that has not been picked', () => {
    expect(run(initialResetWallState(), { type: 'PHOTO_CONFIRMED' }).step).toBe('photo');
  });

  it('keeps the photo and the corners when the upload fails, so Try again retries the upload', () => {
    const state = run(
      atAnchors(),
      { type: 'ANCHORS_SET', anchors: SQUARE },
      { type: 'ANCHORS_DONE' },
      { type: 'UPLOAD_STARTED' },
      { type: 'UPLOAD_FAILED', message: 'The photo did not make it up' },
    );
    expect(state.step).toBe('upload');
    expect(state.photo).toEqual(PHOTO);
    expect(state.anchors).toEqual(SQUARE);
    expect(state.upload.attempts).toBe(1);
  });

  it('counts attempts per photo and resets them when the photo changes', () => {
    const failed = run(
      atAnchors(),
      { type: 'ANCHORS_SET', anchors: SQUARE },
      { type: 'ANCHORS_DONE' },
      { type: 'UPLOAD_STARTED' },
      { type: 'UPLOAD_FAILED', message: 'nope' },
      { type: 'UPLOAD_STARTED' },
    );
    expect(failed.upload.attempts).toBe(2);
    expect(run(failed, { type: 'PHOTO_PICKED', photo: OTHER_PHOTO }).upload.attempts).toBe(0);
  });

  it('lands on compare when detection finishes, carrying the candidates', () => {
    const state = run(
      atAnchors(),
      { type: 'ANCHORS_SET', anchors: SQUARE },
      { type: 'ANCHORS_DONE' },
      { type: 'DRAFT_CREATED', draft: DRAFT },
      { type: 'DETECTION_STARTED' },
      { type: 'DETECTION_FINISHED', candidates: [{ cx: 10, cy: 10, r: 4, confidence: 0.9 }] },
    );
    expect(state.step).toBe('compare');
    expect(state.detection.candidates).toHaveLength(1);
  });

  it('lands on compare with nothing found when the phone cannot suggest holds', () => {
    const state = run(
      atAnchors(),
      { type: 'ANCHORS_SET', anchors: SQUARE },
      { type: 'ANCHORS_DONE' },
      { type: 'DRAFT_CREATED', draft: DRAFT },
      { type: 'DETECTION_UNAVAILABLE' },
    );
    expect(state.step).toBe('compare');
    expect(state.detection.outcome).toBe('unavailable');
    expect(state.detection.candidates).toHaveLength(0);
  });

  it('says leaving keeps the draft only once the draft exists', () => {
    const before = run(atAnchors(), { type: 'ANCHORS_SET', anchors: SQUARE });
    expect(leavingKeepsDraft(before)).toBe(false);
    const after = run(before, { type: 'ANCHORS_DONE' }, { type: 'DRAFT_CREATED', draft: DRAFT });
    expect(leavingKeepsDraft(after)).toBe(true);
    expect(leavingKeepsDraft(run(after, { type: 'COMMITTED' }))).toBe(false);
  });

  it('declines BACK while a request is in flight', () => {
    const uploading = run(
      atAnchors(),
      { type: 'ANCHORS_SET', anchors: SQUARE },
      { type: 'ANCHORS_DONE' },
      { type: 'UPLOAD_STARTED' },
    );
    expect(isBusy(uploading)).toBe(true);
    expect(run(uploading, { type: 'BACK' }).step).toBe('upload');
  });

  it('has nowhere to go back to from compare — the draft is on the server by then', () => {
    const comparing = run(
      atAnchors(),
      { type: 'ANCHORS_SET', anchors: SQUARE },
      { type: 'ANCHORS_DONE' },
      { type: 'DRAFT_CREATED', draft: DRAFT },
      { type: 'DETECTION_FINISHED', candidates: [] },
    );
    expect(run(comparing, { type: 'BACK' }).step).toBe('compare');
  });

  // The predicate behind `beforeRemove`, which is what the header's back button,
  // the iOS back gesture and Android's Back key all pass through. The footer's
  // Back was guarded and none of those were: a silent exit mid-upload lands a
  // callback on a route that has gone, and a silent exit after the draft exists
  // strands a draft on the server whose detections lived only in that session —
  // unresumable, so the owner has to discard it and shoot the wall again.
  it('asks before leaving once the draft is on the server', () => {
    const before = run(atAnchors(), { type: 'ANCHORS_SET', anchors: SQUARE });
    expect(shouldConfirmLeave(before)).toBe(false);

    const withDraft = run(before, { type: 'ANCHORS_DONE' }, { type: 'DRAFT_CREATED', draft: DRAFT });
    expect(shouldConfirmLeave(withDraft)).toBe(true);
  });

  it('asks before leaving mid-request, draft or no draft', () => {
    const uploading = run(
      atAnchors(),
      { type: 'ANCHORS_SET', anchors: SQUARE },
      { type: 'ANCHORS_DONE' },
      { type: 'UPLOAD_STARTED' },
    );
    expect(leavingKeepsDraft(uploading)).toBe(false);
    expect(shouldConfirmLeave(uploading)).toBe(true);

    const detecting = run(
      atAnchors(),
      { type: 'ANCHORS_SET', anchors: SQUARE },
      { type: 'ANCHORS_DONE' },
      { type: 'DRAFT_CREATED', draft: DRAFT },
      { type: 'DETECTION_STARTED' },
    );
    expect(shouldConfirmLeave(detecting)).toBe(true);
  });

  // One prompt per leave. The footer used to ask, pop, and be asked again by
  // `beforeRemove` on the way out — two identical alerts on one tap, and the
  // second's "Stay" silently undid the answer to the first. So the footer's
  // outcomes are "step back" and "pop the route", with no third that could
  // prompt; popping is what raises the question, once, in the one listener every
  // exit passes through.
  it('pops the route from the steps that mean leaving, and never prompts itself', () => {
    const atPhoto = initialResetWallState();
    expect(resetBackAction(atPhoto)).toBe('pop-route');

    const comparing = run(
      atAnchors(),
      { type: 'ANCHORS_SET', anchors: SQUARE },
      { type: 'ANCHORS_DONE' },
      { type: 'DRAFT_CREATED', draft: DRAFT },
      { type: 'DETECTION_FINISHED', candidates: [] },
    );
    expect(resetBackAction(comparing)).toBe('pop-route');
    // And it is the LISTENER's job to ask on the way out, not the footer's.
    expect(shouldConfirmLeave(comparing)).toBe(true);
  });

  it('steps back within the flow everywhere else', () => {
    expect(resetBackAction(atAnchors())).toBe('step-back');

    const uploading = run(
      atAnchors(),
      { type: 'ANCHORS_SET', anchors: SQUARE },
      { type: 'ANCHORS_DONE' },
      { type: 'UPLOAD_FAILED', message: 'nope' },
    );
    expect(resetBackAction(uploading)).toBe('step-back');
  });

  it('lets a finished reset go without a question', () => {
    const done = run(
      atAnchors(),
      { type: 'ANCHORS_SET', anchors: SQUARE },
      { type: 'ANCHORS_DONE' },
      { type: 'DRAFT_CREATED', draft: DRAFT },
      { type: 'DETECTION_FINISHED', candidates: [] },
      { type: 'COMMITTED' },
    );
    expect(shouldConfirmLeave(done)).toBe(false);
  });

  it('backing out of the corners keeps them — the climber may be checking the photo', () => {
    const state = run(atAnchors(), { type: 'ANCHORS_SET', anchors: SQUARE }, { type: 'BACK' });
    expect(state.step).toBe('photo');
    expect(state.anchors).toEqual(SQUARE);
  });
});
