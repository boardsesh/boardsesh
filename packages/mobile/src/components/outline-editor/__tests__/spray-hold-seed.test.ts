import { describe, expect, it } from 'vitest';
import { IDENTITY_HOMOGRAPHY } from '@boardsesh/spray-wall-geometry';
import {
  buildEditorSeed,
  holdsToCarryOver,
  seedIncludesCandidates,
  seedReason,
  sprayEditorSeedKey,
  type SeedableWall,
  type SeedDecisionInput,
} from '../spray-hold-seed';
import {
  initialSprayEditorState,
  sprayEditorReducer,
  type SprayEditorAction,
  type SprayEditorState,
} from '../spray-hold-editor-reducer';
import { buildSprayHoldWritePlan } from '../spray-hold-writes';
import type { SprayHoldCandidate } from '../spray-hold-editor-types';

function wallWith(version: number, holdIds: number[], registeredAtMs = 1_000): SeedableWall {
  return {
    wallUuid: 'wall-1',
    version,
    registeredAtMs,
    holds: holdIds.map((id) => ({ id, cx: id * 10, cy: 50, r: 12 })),
  };
}

/** Everything quiet: one wall already seeded, nothing pending. */
function settled(wall: SeedableWall, overrides: Partial<SeedDecisionInput> = {}): SeedDecisionInput {
  return {
    seedKey: sprayEditorSeedKey(wall),
    seededKey: sprayEditorSeedKey(wall),
    wall,
    seededWall: wall,
    candidatesChanged: false,
    awaitingSavedPayload: false,
    saveStartedAtMs: null,
    ...overrides,
  };
}

function run(state: SprayEditorState, ...actions: SprayEditorAction[]): SprayEditorState {
  return actions.reduce(sprayEditorReducer, state);
}

describe('seedReason', () => {
  const wall = wallWith(3, [1, 2]);

  it('seeds the first time a wall arrives', () => {
    expect(seedReason(settled(wall, { seededKey: null, seededWall: null }))).toBe('new-version');
  });

  it('seeds a new version of the same wall', () => {
    const next = wallWith(4, [1, 2]);
    expect(seedReason(settled(next, { seededKey: sprayEditorSeedKey(wall), seededWall: wall }))).toBe('new-version');
  });

  it('seeds when a different detector run arrives', () => {
    expect(seedReason(settled(wall, { candidatesChanged: true }))).toBe('new-candidates');
  });

  it('does NOT seed when the registry merely re-registers the same wall', () => {
    // A refreshed presigned photo signature is enough to produce a new payload
    // object. Seeding on that throws away whatever is half-drawn.
    const refreshed = wallWith(3, [1, 2], 2_000);
    expect(seedReason(settled(refreshed, { seededWall: wall }))).toBeNull();
  });

  describe('after a save', () => {
    it('does NOT seed from the payload it already had', () => {
      // `invalidateQueries` is not the refetch. This is the exact object that was
      // on screen when Save was pressed, so it predates the write: seeding from
      // it makes the just-added holds vanish and the just-deleted ones return.
      expect(seedReason(settled(wall, { awaitingSavedPayload: true, saveStartedAtMs: 5_000 }))).toBeNull();
    });

    it('does NOT seed from a payload registered BEFORE the save was sent', () => {
      // A presigned-photo refresh landing mid-save is a new object holding old
      // holds. Only the timestamp tells it from the refetch's answer.
      const midSaveRefresh = wallWith(3, [1, 2], 4_000);
      expect(
        seedReason(settled(midSaveRefresh, { seededWall: wall, awaitingSavedPayload: true, saveStartedAtMs: 5_000 })),
      ).toBeNull();
    });

    it('seeds once a payload newer than the save lands', () => {
      const refetched = wallWith(3, [1, 2, 3], 6_000);
      expect(
        seedReason(settled(refetched, { seededWall: wall, awaitingSavedPayload: true, saveStartedAtMs: 5_000 })),
      ).toBe('saved-payload');
    });

    it('does not re-offer the detector proposals', () => {
      expect(seedIncludesCandidates('saved-payload')).toBe(false);
      expect(seedIncludesCandidates('new-version')).toBe(true);
      expect(seedIncludesCandidates('new-candidates')).toBe(true);
    });
  });

  it('never seeds with no wall', () => {
    expect(
      seedReason({
        seedKey: null,
        seededKey: null,
        wall: null,
        seededWall: null,
        candidatesChanged: true,
        awaitingSavedPayload: true,
        saveStartedAtMs: null,
      }),
    ).toBeNull();
  });
});

describe('sprayEditorSeedKey', () => {
  it('names the wall and its version, and nothing else', () => {
    // A key folding the CANDIDATE COUNT in reads a fresh run of the same length
    // as "no change" — so updated proposals never appear — and reads a run of a
    // different length as a new VERSION, which lets already-accepted candidates
    // back into the pending list.
    expect(sprayEditorSeedKey(wallWith(3, [1]))).toBe('wall-1:3');
    expect(sprayEditorSeedKey(wallWith(4, [1]))).toBe('wall-1:4');
    expect(sprayEditorSeedKey(null)).toBeNull();
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

  it("carries this session's provenance off the wall rather than calling everything manual", () => {
    // A hold the detector found and the owner accepted comes back AUTO. Seeding
    // it as MANUAL means the next nudge overwrites what the wall records.
    const wall: SeedableWall = {
      wallUuid: 'wall-1',
      version: 2,
      holds: [
        { id: 1, cx: 10, cy: 10, r: 8, source: 'AUTO', confidence: 0.81 },
        { id: 2, cx: 20, cy: 20, r: 8, source: 'MANUAL', confidence: null },
        { id: 3, cx: 30, cy: 30, r: 8 },
      ],
    };
    const seeded = buildEditorSeed(wall, [], false);
    expect(seeded[0]).toMatchObject({ source: 'AUTO', confidence: 0.81, review: 'accepted', dirty: false });
    expect(seeded[1]).toMatchObject({ source: 'MANUAL', confidence: null });
    // A payload written before provenance existed: manual is the honest default.
    expect(seeded[2]).toMatchObject({ source: 'MANUAL', confidence: null });
  });

  it('carries unsaved work over the re-seed, replacing the server copy', () => {
    const carried = {
      id: 4,
      cx: 999,
      cy: 999,
      r: 30,
      outline: null,
      source: 'MANUAL' as const,
      confidence: null,
      review: 'accepted' as const,
      dirty: true,
    };
    const local = { ...carried, id: -1 };
    const seeded = buildEditorSeed(wallWith(1, [4, 5]), [], false, [carried, local]);
    // The server's copy of #4 loses to this session's newer geometry...
    expect(seeded.find((hold) => hold.id === 4)).toEqual(carried);
    // ...and a hold the server has never seen is appended rather than dropped.
    expect(seeded.find((hold) => hold.id === -1)).toEqual(local);
    expect(seeded.filter((hold) => hold.id === 4)).toHaveLength(1);
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

    const saved = sprayEditorReducer(drawn, { type: 'MARK_SAVED', writtenIds: [-1] });
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

describe('holdsToCarryOver', () => {
  const base = { cx: 0, cy: 0, r: 5, outline: null, confidence: null } as const;

  it('carries dirty holds and nothing else', () => {
    const holds = [
      { ...base, id: 1, source: 'MANUAL' as const, review: 'accepted' as const, dirty: true },
      { ...base, id: 2, source: 'MANUAL' as const, review: 'accepted' as const, dirty: false },
      // A proposal is never carried: the fresh payload brings its own.
      { ...base, id: -1, source: 'AUTO' as const, review: 'pending' as const, dirty: true },
    ];
    expect(holdsToCarryOver(holds).map((hold) => hold.id)).toEqual([1]);
  });
});
