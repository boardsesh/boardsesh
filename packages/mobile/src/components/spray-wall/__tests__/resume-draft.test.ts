import { describe, expect, it } from 'vitest';
import {
  detailsSeedFromWall,
  findOpenDraft,
  findResumableWall,
  planUploadRetry,
  resumeTargetFor,
  startOverPlan,
  type ResumableVersion,
  type ResumableWall,
} from '../resume-draft';

function wall(overrides: Partial<ResumableWall> = {}): ResumableWall {
  return {
    uuid: 'wall-1',
    layoutId: 9001,
    viewerCanEdit: true,
    board: { name: 'Garage wall' },
    currentVersion: null,
    ...overrides,
  };
}

const DRAFT_WITH_PHOTO: ResumableVersion = {
  id: 'version-1',
  number: 1,
  status: 'draft',
  photo: { url: 'https://example.invalid/wall.jpg' },
  addedHoldCount: 0,
};

const DRAFT_WITHOUT_PHOTO: ResumableVersion = { id: 'version-1', number: 1, status: 'draft', photo: null };

describe('findResumableWall', () => {
  it('finds a wall that never published', () => {
    expect(findResumableWall([wall()])?.uuid).toBe('wall-1');
  });

  it('ignores a wall that has published — that is a board, not an abandoned attempt', () => {
    expect(findResumableWall([wall({ currentVersion: { id: 'version-9' } })])).toBeNull();
  });

  it('ignores an unfinished wall the viewer may not edit', () => {
    // A gym's wall can reach this list; resuming somebody else's half-built wall
    // is not a thing this flow may do.
    expect(findResumableWall([wall({ viewerCanEdit: false })])).toBeNull();
  });

  it('answers null for an empty list', () => {
    expect(findResumableWall([])).toBeNull();
  });

  // A reset clone carries the live wall's name, and finishing it archives that
  // wall. "Add a wall" must never offer it back; the reset does.
  it('leaves an unfinished reset clone to its own reset', () => {
    expect(findResumableWall([wall({ resetOfWallUuid: 'live-wall' })])).toBeNull();
    expect(findResumableWall([wall({ uuid: 'clone', resetOfWallUuid: 'live-wall' }), wall()])?.uuid).toBe('wall-1');
  });

  it('picks the same wall every time when two were abandoned', () => {
    const walls = [wall({ uuid: 'wall-a' }), wall({ uuid: 'wall-b' })];
    expect(findResumableWall(walls)?.uuid).toBe('wall-a');
    expect(findResumableWall(walls)?.uuid).toBe('wall-a');
  });
});

describe('findOpenDraft', () => {
  it('finds the draft whatever case the status arrives in', () => {
    expect(findOpenDraft([{ ...DRAFT_WITH_PHOTO, status: 'DRAFT' }])?.id).toBe('version-1');
  });

  it('never returns a published or superseded version', () => {
    expect(findOpenDraft([{ ...DRAFT_WITH_PHOTO, status: 'published' }])).toBeNull();
    expect(findOpenDraft([{ ...DRAFT_WITH_PHOTO, status: 'superseded' }])).toBeNull();
  });
});

describe('resumeTargetFor', () => {
  it('rejoins at the editor when the draft already carries a photo', () => {
    const target = resumeTargetFor(wall(), [DRAFT_WITH_PHOTO]);
    expect(target).toEqual({
      at: 'review',
      draft: { wallUuid: 'wall-1', layoutId: 9001, viewerCanEdit: true, versionId: 'version-1', versionNumber: 1 },
      savedHoldCount: 0,
    });
  });

  it('reports holds a previous sitting already saved', () => {
    // The gate that unlocks Done. The editor loads persisted holds as CLEAN
    // state, so its own Save stays disabled — a Done waiting for a save of its
    // own would leave the climber unable to publish without a pointless edit.
    const target = resumeTargetFor(wall(), [{ ...DRAFT_WITH_PHOTO, addedHoldCount: 42 }]);
    expect(target.at === 'review' && target.savedHoldCount).toBe(42);
  });

  it('treats a missing or negative hold count as none', () => {
    const missing = resumeTargetFor(wall(), [{ ...DRAFT_WITH_PHOTO, addedHoldCount: null }]);
    expect(missing.at === 'review' && missing.savedHoldCount).toBe(0);
    const negative = resumeTargetFor(wall(), [{ ...DRAFT_WITH_PHOTO, addedHoldCount: -3 }]);
    expect(negative.at === 'review' && negative.savedHoldCount).toBe(0);
  });

  it('rejoins at the photo step when the wall has no version at all', () => {
    const target = resumeTargetFor(wall(), []);
    expect(target).toEqual({ at: 'photo', wall: { wallUuid: 'wall-1', layoutId: 9001, viewerCanEdit: true } });
  });

  it('rejoins at the photo step for a draft with nothing to draw on', () => {
    // A draft with no photo is the same as no draft for this decision: the
    // editor has no pixels, and the upload will adopt one onto the open draft.
    expect(resumeTargetFor(wall(), [DRAFT_WITHOUT_PHOTO]).at).toBe('photo');
  });

  it('reuses the wall rather than minting a new one, either way round', () => {
    for (const versions of [[DRAFT_WITH_PHOTO], [], [DRAFT_WITHOUT_PHOTO]]) {
      const target = resumeTargetFor(wall(), versions);
      const uuid = target.at === 'review' ? target.draft.wallUuid : target.wall.wallUuid;
      expect(uuid).toBe('wall-1');
    }
  });
});

describe('startOverPlan', () => {
  it('discards the open draft before deleting the wall', () => {
    expect(startOverPlan(wall(), [DRAFT_WITH_PHOTO])).toEqual({
      discardVersionId: 'version-1',
      deleteWallUuid: 'wall-1',
    });
  });

  it('deletes a bare wall with nothing to discard', () => {
    expect(startOverPlan(wall(), [])).toEqual({ discardVersionId: null, deleteWallUuid: 'wall-1' });
  });
});

describe('planUploadRetry', () => {
  it('never queries on a first attempt', () => {
    // Paying for a round trip before every upload would slow the common path for
    // nothing: there is no earlier attempt to reconcile against.
    expect(planUploadRetry(null, 0)).toEqual({ action: 'upload' });
  });

  it('adopts a draft the lost response had already created', () => {
    const plan = planUploadRetry({ ...wall(), versions: [{ ...DRAFT_WITH_PHOTO, addedHoldCount: 7 }] }, 1);
    expect(plan).toEqual({
      action: 'adopt',
      draft: { wallUuid: 'wall-1', layoutId: 9001, viewerCanEdit: true, versionId: 'version-1', versionNumber: 1 },
      savedHoldCount: 7,
    });
  });

  it('re-uploads when the wall genuinely has nothing on it', () => {
    expect(planUploadRetry({ ...wall(), versions: [] }, 1)).toEqual({ action: 'upload' });
    expect(planUploadRetry({ ...wall(), versions: [DRAFT_WITHOUT_PHOTO] }, 1)).toEqual({ action: 'upload' });
  });

  it('blocks — never re-uploads — when the wall could not be READ', () => {
    // The bug this answers: falling through here re-uploads the photo and then
    // meets the one-open-draft refusal if the first attempt did land, so on a
    // marginal connection the same failure repeats with nothing to explain it.
    // A read that failed is not "there is no draft".
    expect(planUploadRetry(null, 1)).toEqual({ action: 'blocked' });
    expect(planUploadRetry(null, 5)).toEqual({ action: 'blocked' });
  });
});

describe('detailsSeedFromWall', () => {
  const BOARD = {
    name: 'Garage wall',
    angle: 35,
    isPublic: false,
    isUnlisted: false,
    hideLocation: true,
    locationName: 'The Castle',
    latitude: 51.5,
    longitude: -0.1,
    gymUuid: 'gym-1',
    gymName: 'The Castle',
  };

  it('prefills from the board row', () => {
    expect(detailsSeedFromWall({ board: BOARD })).toEqual({
      name: 'Garage wall',
      angle: 35,
      isPublic: false,
      isUnlisted: false,
      hideLocation: true,
      locationName: 'The Castle',
      coords: { latitude: 51.5, longitude: -0.1 },
      gym: { uuid: 'gym-1', name: 'The Castle' },
    });
  });

  // The row stays private until the first publish, so it alone would tell a
  // climber who chose Public last time that they chose Private.
  it('prefers the visibility parked for the first publish over the private row', () => {
    const seed = detailsSeedFromWall({ board: BOARD, pendingVisibility: { isPublic: true, isUnlisted: false } });
    expect(seed).toMatchObject({ isPublic: true, isUnlisted: false });
    const unlisted = detailsSeedFromWall({ board: BOARD, pendingVisibility: { isPublic: false, isUnlisted: true } });
    expect(unlisted).toMatchObject({ isPublic: false, isUnlisted: true });
  });

  it('falls back to the row when nothing is parked', () => {
    expect(detailsSeedFromWall({ board: { ...BOARD, isUnlisted: true }, pendingVisibility: null })).toMatchObject({
      isPublic: false,
      isUnlisted: true,
    });
  });

  // The builder refuses to show it and keeps it as the baseline, so Save
  // writes the angle on screen; a snapped seed would hide the mismatch.
  it('passes an angle off the list through as stored', () => {
    expect(detailsSeedFromWall({ board: { ...BOARD, angle: 37 } }).angle).toBe(37);
  });

  it('says no gym, no point and no location name when the wall has none', () => {
    const seed = detailsSeedFromWall({
      board: { ...BOARD, gymUuid: null, gymName: null, latitude: null, longitude: null, locationName: null },
    });
    expect(seed.gym).toBeNull();
    expect(seed.coords).toBeNull();
    expect(seed.locationName).toBe('');
  });

  // The create response selects fewer fields than were sent: what it leaves
  // out, the builder keeps.
  it('leaves out what the read did not select', () => {
    const seed = detailsSeedFromWall({ board: { name: 'Garage wall', angle: 40, isPublic: false, isUnlisted: false } });
    expect(seed).toEqual({ name: 'Garage wall', angle: 40, isPublic: false, isUnlisted: false });
    expect(detailsSeedFromWall({ board: null })).toEqual({});
  });
});
