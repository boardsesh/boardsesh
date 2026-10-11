import { describe, it, expect, vi } from 'vitest';
import {
  mergeUniquePlaylistClimbs,
  preparePlaylistClimbs,
  createPlaylistSuggestionSource,
  findPlaylistClimbIndex,
  playlistSuggestionSourceMatches,
  pruneSuggestedQueueItemsAfterCurrent,
  reanchorPlaylistSuggestionSource,
} from '../playlist-suggestions';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '../types';

function makeClimb(uuid: string, name?: string): Climb {
  return { uuid, name: name ?? `Climb ${uuid}` } as Climb;
}

function makeQueueItem(uuid: string, options: { suggested?: boolean; climbUuid?: string } = {}): ClimbQueueItem {
  return {
    uuid,
    climb: { uuid: options.climbUuid ?? `climb-${uuid}`, name: 'Test', mirrored: false } as Climb,
    addedBy: null,
    suggested: options.suggested ?? false,
  } as ClimbQueueItem;
}

describe('mergeUniquePlaylistClimbs', () => {
  it('deduplicates climbs by uuid', () => {
    const activated = makeClimb('a');
    const climbs = [makeClimb('a'), makeClimb('b'), makeClimb('b'), makeClimb('c')];

    const result = mergeUniquePlaylistClimbs(activated, climbs);
    const uuids = result.map((climb) => climb.uuid);
    expect(uuids).toEqual(['a', 'b', 'c']);
  });

  it('always includes the activated climb even if not in climbs list', () => {
    const activated = makeClimb('activated');
    const climbs = [makeClimb('x'), makeClimb('y')];

    const result = mergeUniquePlaylistClimbs(activated, climbs);
    expect(result.map((climb) => climb.uuid)).toContain('activated');
  });

  it('does not duplicate activated climb if already present', () => {
    const activated = makeClimb('a');
    const climbs = [makeClimb('a'), makeClimb('b')];

    const result = mergeUniquePlaylistClimbs(activated, climbs);
    expect(result).toHaveLength(2);
  });
});

describe('playlistSuggestionSourceMatches', () => {
  const source: PlaylistSuggestionSource = {
    playlistUuid: 'playlist-1',
    activatedClimbUuid: 'climb-1',
    boardKey: 'kilter-1-1',
    climbs: [],
  };

  it('returns true when all fields match', () => {
    expect(playlistSuggestionSourceMatches(source, { ...source })).toBe(true);
  });

  it('returns false when playlistUuid differs', () => {
    expect(playlistSuggestionSourceMatches(source, { ...source, playlistUuid: 'different' })).toBe(false);
  });

  it('returns false when activatedClimbUuid differs', () => {
    expect(playlistSuggestionSourceMatches(source, { ...source, activatedClimbUuid: 'different' })).toBe(false);
  });

  it('returns false when boardKey differs', () => {
    expect(playlistSuggestionSourceMatches(source, { ...source, boardKey: 'different' })).toBe(false);
  });

  it('returns false when current is null', () => {
    expect(playlistSuggestionSourceMatches(null, source)).toBe(false);
  });
});

describe('pruneSuggestedQueueItemsAfterCurrent', () => {
  it('removes suggested items after current but preserves non-suggested', () => {
    const current = makeQueueItem('current');
    const suggestedAfter = makeQueueItem('suggested-after', { suggested: true });
    const manualAfter = makeQueueItem('manual-after', { suggested: false });
    const queue = [current, suggestedAfter, manualAfter];

    const result = pruneSuggestedQueueItemsAfterCurrent(queue, current);
    expect(result.map((item) => item.uuid)).toEqual(['current', 'manual-after']);
  });

  it('preserves suggested items before current', () => {
    const suggestedBefore = makeQueueItem('suggested-before', { suggested: true });
    const current = makeQueueItem('current');
    const suggestedAfter = makeQueueItem('suggested-after', { suggested: true });
    const queue = [suggestedBefore, current, suggestedAfter];

    const result = pruneSuggestedQueueItemsAfterCurrent(queue, current);
    expect(result.map((item) => item.uuid)).toEqual(['suggested-before', 'current']);
  });

  it('returns unchanged queue when current item is not found', () => {
    const itemA = makeQueueItem('a');
    const notInQueue = makeQueueItem('not-in-queue');
    const queue = [itemA];

    const result = pruneSuggestedQueueItemsAfterCurrent(queue, notInQueue);
    expect(result).toBe(queue);
  });
});

describe('reanchorPlaylistSuggestionSource', () => {
  const source = (activatedClimbUuid: string, uuids: string[]): PlaylistSuggestionSource => ({
    playlistUuid: 'list-1',
    activatedClimbUuid,
    boardKey: 'kilter:1:10:1,2',
    climbs: uuids.map((uuid) => makeClimb(uuid)),
  });

  // The bug this exists for: a climber browses a track from `a` to `d` and puts
  // `d` up. Committing with the source still anchored on `a` aims "next" at `b` —
  // a climb they swiped past three gestures ago.
  it('moves the anchor to the climb actually being committed', () => {
    const reanchored = reanchorPlaylistSuggestionSource(source('a', ['a', 'b', 'c', 'd']), 'd');
    expect(reanchored?.activatedClimbUuid).toBe('d');
    expect(reanchored?.climbs.map((climb) => climb.uuid)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns the SAME reference when the anchor is already right', () => {
    // Identity matters: this feeds a context value and a re-anchor that always
    // allocated would churn every consumer on each commit.
    const original = source('a', ['a', 'b']);
    expect(reanchorPlaylistSuggestionSource(original, 'a')).toBe(original);
  });

  it('leaves a source alone when the climb is not in it', () => {
    // Anchoring on a climb the source does not contain makes `activatedIndex`
    // -1, which reads the whole list as exhausted — worse than a stale anchor.
    const original = source('a', ['a', 'b']);
    expect(reanchorPlaylistSuggestionSource(original, 'zz')).toBe(original);
  });

  it('handles a missing source or climb uuid', () => {
    expect(reanchorPlaylistSuggestionSource(null, 'a')).toBeNull();
    const original = source('a', ['a']);
    expect(reanchorPlaylistSuggestionSource(original, undefined)).toBe(original);
  });
});

describe('prepared playlist tracks', () => {
  it('keeps first-occurrence semantics when a later compatible duplicate follows an incompatible row', () => {
    const first = makeClimb('duplicate', 'blocked');
    const climbs = [first, makeClimb('duplicate', 'allowed'), makeClimb('active')];
    const isClimbable = (candidate: Climb) => candidate.name !== 'blocked';
    const args = { playlistUuid: 'prepared', boardKey: 'board', climbs, activatedClimb: climbs[2], isClimbable };
    expect(
      createPlaylistSuggestionSource({ ...args, preparedClimbs: preparePlaylistClimbs(climbs, isClimbable) }),
    ).toEqual(createPlaylistSuggestionSource(args));
    expect(preparePlaylistClimbs(climbs, isClimbable).climbs).toEqual([climbs[2]]);
  });

  it('reuses the compatible ordered track across ordinary activations without filtering again', () => {
    const first = makeClimb('a', 'first');
    const duplicate = makeClimb('a', 'duplicate');
    const climbs = [first, makeClimb('blocked'), duplicate, makeClimb('b')];
    const isClimbable = vi.fn((climb: Climb) => climb.uuid !== 'blocked');
    const preparedClimbs = preparePlaylistClimbs(climbs, isClimbable);
    expect(isClimbable).toHaveBeenCalledTimes(3);
    for (const activatedClimb of [first, climbs[3]]) {
      const source = createPlaylistSuggestionSource({
        playlistUuid: 'prepared',
        boardKey: 'board',
        climbs,
        activatedClimb,
        isClimbable,
        preparedClimbs,
      });
      expect(source.climbs).toBe(preparedClimbs.climbs);
      expect(source.climbs).toEqual([first, climbs[3]]);
      expect(findPlaylistClimbIndex(source, 'b')).toBe(1);
      expect(findPlaylistClimbIndex(reanchorPlaylistSuggestionSource(source, 'b')!, 'a')).toBe(0);
    }
    expect(isClimbable).toHaveBeenCalledTimes(3);
  });

  it.each(['blocked', 'absent'])('preserves original activated inclusion for %s', (activatedUuid) => {
    const climbs = [makeClimb('a'), makeClimb('blocked'), makeClimb('b')];
    const activatedClimb = makeClimb(activatedUuid);
    const isClimbable = (climb: Climb) => climb.uuid !== 'blocked';
    const args = { playlistUuid: 'prepared', boardKey: 'board', climbs, activatedClimb, isClimbable };
    expect(
      createPlaylistSuggestionSource({ ...args, preparedClimbs: preparePlaylistClimbs(climbs, isClimbable) }),
    ).toEqual(createPlaylistSuggestionSource(args));
  });

  it('rejects preparations from another snapshot or board predicate', () => {
    const climbs = [makeClimb('a'), makeClimb('b')];
    const args = { playlistUuid: 'prepared', boardKey: 'board', climbs, activatedClimb: climbs[0] };
    const preparedClimbs = preparePlaylistClimbs(climbs);
    const source = createPlaylistSuggestionSource({ ...args, preparedClimbs, isClimbable: () => false });
    expect(source.climbs).toEqual([climbs[0]]);
    const updatedClimbs = [climbs[0], makeClimb('c')];
    expect(createPlaylistSuggestionSource({ ...args, climbs: updatedClimbs, preparedClimbs }).climbs).toEqual(
      updatedClimbs,
    );
  });
});
