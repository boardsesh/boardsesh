import { describe, expect, it } from 'vitest';
import { IDENTITY_HOMOGRAPHY } from '@boardsesh/spray-wall-geometry';
import { buildEditorSeed, shouldSeedEditor, sprayEditorSeedKey, type SeedableWall } from '../spray-hold-seed';
import {
  initialSprayEditorState,
  sprayEditorReducer,
  type SprayEditorAction,
  type SprayEditorState,
} from '../spray-hold-editor-reducer';
import { buildSprayHoldWritePlan } from '../spray-hold-writes';
import type { SprayHoldCandidate } from '../spray-hold-editor-types';

function wallWith(version: number, holdIds: number[]): SeedableWall {
  return {
    wallUuid: 'wall-1',
    version,
    holds: holdIds.map((id) => ({ id, cx: id * 10, cy: 50, r: 12 })),
  };
}

function run(state: SprayEditorState, ...actions: SprayEditorAction[]): SprayEditorState {
  return actions.reduce(sprayEditorReducer, state);
}

describe('shouldSeedEditor', () => {
  const wall = wallWith(3, [1, 2]);
  const key = sprayEditorSeedKey(wall, 0);

  it('seeds the first time a wall arrives', () => {
    expect(
      shouldSeedEditor({ seedKey: key, seededKey: null, wall, seededWall: null, awaitingSavedPayload: false }),
    ).toBe(true);
  });

  it('seeds a new version of the same wall', () => {
    const next = wallWith(4, [1, 2]);
    expect(
      shouldSeedEditor({
        seedKey: sprayEditorSeedKey(next, 0),
        seededKey: key,
        wall: next,
        seededWall: wall,
        awaitingSavedPayload: false,
      }),
    ).toBe(true);
  });

  it('seeds when a new detector run arrives', () => {
    expect(
      shouldSeedEditor({
        seedKey: sprayEditorSeedKey(wall, 12),
        seededKey: key,
        wall,
        seededWall: wall,
        awaitingSavedPayload: false,
      }),
    ).toBe(true);
  });

  it('does NOT seed when the registry merely re-registers the same wall', () => {
    // A refreshed presigned photo signature is enough to produce a new payload
    // object. Seeding on that throws away whatever is half-drawn.
    const refreshed = wallWith(3, [1, 2]);
    expect(
      shouldSeedEditor({
        seedKey: sprayEditorSeedKey(refreshed, 0),
        seededKey: key,
        wall: refreshed,
        seededWall: wall,
        awaitingSavedPayload: false,
      }),
    ).toBe(false);
  });

  describe('after a save', () => {
    it('does NOT seed from the payload it already had', () => {
      // `invalidateQueries` is not the refetch. This is the exact object that was
      // on screen when Save was pressed, so it predates the write: seeding from
      // it makes the just-added holds vanish and the just-deleted ones return.
      expect(
        shouldSeedEditor({
          seedKey: key,
          seededKey: key,
          wall,
          seededWall: wall,
          awaitingSavedPayload: true,
        }),
      ).toBe(false);
    });

    it('seeds once a DIFFERENT payload lands', () => {
      const refetched = wallWith(3, [1, 2, 3]);
      expect(
        shouldSeedEditor({
          seedKey: sprayEditorSeedKey(refetched, 0),
          seededKey: key,
          wall: refetched,
          seededWall: wall,
          awaitingSavedPayload: true,
        }),
      ).toBe(true);
    });
  });

  it('never seeds with no wall', () => {
    expect(
      shouldSeedEditor({ seedKey: null, seededKey: null, wall: null, seededWall: null, awaitingSavedPayload: true }),
    ).toBe(false);
  });
});

describe('buildEditorSeed', () => {
  const candidates: SprayHoldCandidate[] = [
    { cx: 5, cy: 5, r: 9, confidence: 0.9 },
    { cx: 6, cy: 6, r: 9, confidence: 0.3 },
  ];

  it('seeds stored holds clean, accepted and by their server ids', () => {
    const seeded = buildEditorSeed(wallWith(1, [4, 5]), [], false);
    expect(seeded).toHaveLength(2);
    expect(seeded.every((hold) => hold.id > 0 && !hold.dirty && hold.review === 'accepted')).toBe(true);
  });

  it('appends candidates as pending, with negative ids', () => {
    const seeded = buildEditorSeed(wallWith(1, [4]), candidates, true);
    expect(seeded.map((hold) => hold.id)).toEqual([4, -1, -2]);
    expect(seeded[1]).toMatchObject({ source: 'AUTO', review: 'pending', confidence: 0.9, dirty: false });
  });

  it('drops the candidates once the version has been saved', () => {
    // Otherwise the accepted ones — now stored holds in `wall.holds` — would be
    // drawn twice and written again, and the rejected ones would come back.
    const seeded = buildEditorSeed(wallWith(1, [4, 5]), candidates, false);
    expect(seeded.map((hold) => hold.id)).toEqual([4, 5]);
  });
});

describe('the save seam', () => {
  it('a re-seed from the REFETCHED payload leaves only live ids to send', () => {
    // Draw a hold, save it, and let the refetch land: the hold comes back with
    // the server's own id, clean. A second Save then has nothing to send — which
    // is what keeps it from re-adding the hold under a fresh id.
    const drawn = run(
      sprayEditorReducer(initialSprayEditorState(), {
        type: 'LOAD',
        holds: buildEditorSeed(wallWith(2, [7]), [], false),
      }),
      { type: 'ADD_HOLD', geometry: { cx: 300, cy: 300, r: 20, outline: null } },
    );
    expect(buildSprayHoldWritePlan(drawn, IDENTITY_HOMOGRAPHY).upsert).toHaveLength(1);

    const saved = sprayEditorReducer(drawn, { type: 'MARK_SAVED' });
    const reseeded = sprayEditorReducer(saved, {
      type: 'LOAD',
      holds: buildEditorSeed(wallWith(2, [7, 8]), [], false),
    });

    expect(Object.keys(reseeded.holds).sort()).toEqual(['7', '8']);
    expect(buildSprayHoldWritePlan(reseeded, IDENTITY_HOMOGRAPHY).upsert).toEqual([]);
  });

  it('a re-seed from the PRE-SAVE payload would lose the new hold — which is why it must not happen', () => {
    // The characterisation of the bug the seed rule exists to prevent: seeding
    // from the payload that was on screen when Save was pressed drops the hold
    // that was just written, and nothing would ever put it back.
    const drawn = run(
      sprayEditorReducer(initialSprayEditorState(), {
        type: 'LOAD',
        holds: buildEditorSeed(wallWith(2, [7]), [], false),
      }),
      { type: 'ADD_HOLD', geometry: { cx: 300, cy: 300, r: 20, outline: null } },
    );
    const stale = sprayEditorReducer(drawn, { type: 'LOAD', holds: buildEditorSeed(wallWith(2, [7]), [], false) });
    expect(Object.keys(stale.holds)).toEqual(['7']);
  });
});

describe('the removal seam', () => {
  it('MARK_REMOVED stops a failed upsert from re-sending removals on the retry', () => {
    // Removals go first. If the upsert then fails, the holds are already off the
    // wall, and naming them again is refused with "Hold N is not on this wall" —
    // which would fail the retry's whole batch, forever.
    const edited = run(
      sprayEditorReducer(initialSprayEditorState(), {
        type: 'LOAD',
        holds: buildEditorSeed(wallWith(2, [7, 8]), [], false),
      }),
      { type: 'DELETE', ids: [8] },
      { type: 'MOVE_HOLD', id: 7, cx: 1, cy: 1 },
    );
    expect(buildSprayHoldWritePlan(edited, IDENTITY_HOMOGRAPHY).removeIds).toEqual([8]);

    // The remove landed; the upsert did not.
    const afterRemove = sprayEditorReducer(edited, { type: 'MARK_REMOVED' });
    const retry = buildSprayHoldWritePlan(afterRemove, IDENTITY_HOMOGRAPHY);
    expect(retry.removeIds).toEqual([]);
    // ...and the half that failed is still queued, so the retry is worth making.
    expect(retry.upsert).toHaveLength(1);
    expect(retry.upsert[0].id).toBe(7);
  });
});
