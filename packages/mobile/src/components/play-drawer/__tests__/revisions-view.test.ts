import { describe, expect, it } from 'vitest';
import type { ClimbRevisionRow } from '@boardsesh/graphql/operations/climb-revisions';
import { hasRevisionHistory, knownRevisionChanges, pickRevisionBoardPath, revisionEditCount } from '../revisions-view';

function row(revisionNumber: number): ClimbRevisionRow {
  return {
    revisionNumber,
    isCurrent: false,
    createdAt: '2026-09-01T10:00:00.000Z',
    name: 'Left Arete',
    description: null,
    frames: 'p1r1',
    angle: 40,
    difficultyId: null,
    changes: [],
    editor: null,
    editedBySetter: true,
    sprayWallVersionNumber: null,
  };
}

describe('pickRevisionBoardPath', () => {
  it('draws every catalogue board through the ordinary board image', () => {
    expect(pickRevisionBoardPath({ boardName: 'kilter', revisionWallVersion: null, registeredWallVersion: null })).toBe(
      'native',
    );
    // A version number on a catalogue row means nothing and must not divert it.
    expect(pickRevisionBoardPath({ boardName: 'tension', revisionWallVersion: 1, registeredWallVersion: 4 })).toBe(
      'native',
    );
  });

  it('draws a spray revision set on the registered wall version the same way', () => {
    expect(pickRevisionBoardPath({ boardName: 'spray', revisionWallVersion: 3, registeredWallVersion: 3 })).toBe(
      'native',
    );
  });

  it('takes the old-version path only when the version differs', () => {
    expect(pickRevisionBoardPath({ boardName: 'spray', revisionWallVersion: 2, registeredWallVersion: 3 })).toBe(
      'oldSprayVersion',
    );
    expect(pickRevisionBoardPath({ boardName: 'spray', revisionWallVersion: 4, registeredWallVersion: 3 })).toBe(
      'oldSprayVersion',
    );
  });

  it('says there is no board when a spray revision has no wall version on record', () => {
    expect(pickRevisionBoardPath({ boardName: 'spray', revisionWallVersion: null, registeredWallVersion: 3 })).toBe(
      'unavailable',
    );
  });

  it('leaves an unregistered wall to the native path, which is the one that asks for it', () => {
    expect(pickRevisionBoardPath({ boardName: 'spray', revisionWallVersion: 2, registeredWallVersion: null })).toBe(
      'native',
    );
  });
});

describe('revision history helpers', () => {
  it('needs two rows to be a history', () => {
    expect(hasRevisionHistory(undefined)).toBe(false);
    expect(hasRevisionHistory(null)).toBe(false);
    expect(hasRevisionHistory([])).toBe(false);
    expect(hasRevisionHistory([row(1)])).toBe(false);
    expect(hasRevisionHistory([row(2), row(1)])).toBe(true);
  });

  it('counts edits from the newest revision number, so pruned edits still count', () => {
    expect(revisionEditCount([])).toBe(0);
    expect(revisionEditCount([row(2), row(1)])).toBe(1);
    // Past the cap the oldest edits are gone but their numbers are never reused.
    expect(revisionEditCount([row(60), row(59), row(1)])).toBe(59);
  });

  it('names only the changes it has words for, in a fixed order', () => {
    expect(knownRevisionChanges(['rules', 'name', 'holds'])).toEqual(['name', 'holds', 'rules']);
    expect(knownRevisionChanges(['something-newer'])).toEqual([]);
  });
});
