import { describe, expect, it } from 'vitest';
import {
  findOpenDraft,
  findResumableWall,
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
    });
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
