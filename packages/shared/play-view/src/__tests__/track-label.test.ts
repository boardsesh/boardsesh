import { describe, it, expect } from 'vitest';
import { createPlaylistSuggestionSource, type Climb, type PlaylistSuggestionSource } from '@boardsesh/queue';
import { resolveTrackLabel, resolveUpNextTrackLabel, trackLabelListName } from '../track-label';

function makeClimb(uuid: string): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: '',
    setter_username: 'test',
    angle: 40,
    ascensionist_count: 0,
    difficulty: '6a/V3',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
  };
}

const climbs = ['a', 'b', 'c', 'd'].map(makeClimb);

function track(overrides: Partial<PlaylistSuggestionSource> = {}): PlaylistSuggestionSource {
  return { playlistUuid: 'playlist:p', activatedClimbUuid: 'a', boardKey: 'k', climbs, ...overrides };
}

describe('resolveTrackLabel', () => {
  it('names the list and where the climb sits in it', () => {
    expect(resolveTrackLabel(track({ label: 'Projects', total: 23 }), 'c')).toEqual({
      kind: 'counted',
      name: 'Projects',
      position: 3,
      total: 23,
    });
  });

  it('counts from one', () => {
    expect(resolveTrackLabel(track({ label: 'Projects', total: 4 }), 'a')).toMatchObject({ position: 1, total: 4 });
  });

  it('names the list without a count when the total is unknown', () => {
    expect(resolveTrackLabel(track({ label: 'Projects' }), 'b')).toEqual({ kind: 'named', name: 'Projects' });
  });

  it('drops a count that would contradict the position', () => {
    // A total smaller than the climb's place cannot be right; say less instead.
    expect(resolveTrackLabel(track({ label: 'Projects', total: 2 }), 'd')).toEqual({
      kind: 'named',
      name: 'Projects',
    });
    expect(resolveTrackLabel(track({ label: 'Projects', total: 2.5 }), 'a')).toEqual({
      kind: 'named',
      name: 'Projects',
    });
  });

  it('hides with no track, no name, or no climb', () => {
    expect(resolveTrackLabel(null, 'a')).toEqual({ kind: 'hidden' });
    expect(resolveTrackLabel(track(), 'a')).toEqual({ kind: 'hidden' });
    expect(resolveTrackLabel(track({ label: '   ' }), 'a')).toEqual({ kind: 'hidden' });
    expect(resolveTrackLabel(track({ label: 'Projects' }), null)).toEqual({ kind: 'hidden' });
  });

  it('hides for a climb the track does not hold, which navigation is not walking', () => {
    expect(resolveTrackLabel(track({ label: 'Projects', total: 4 }), 'elsewhere')).toEqual({ kind: 'hidden' });
  });

  it('never shows a count for a track that dropped climbs from the list', () => {
    // `b` is filtered out, so `c` is the second climb on the track but the
    // third in the list. The track must not carry the list's total.
    const filtered = createPlaylistSuggestionSource({
      playlistUuid: 'playlist:p',
      activatedClimb: climbs[0],
      climbs,
      boardKey: 'k',
      isClimbable: (climb) => climb.uuid !== 'b',
      label: 'Projects',
      total: 4,
    });
    expect(resolveTrackLabel(filtered, 'c')).toEqual({ kind: 'named', name: 'Projects' });
  });

  it('keeps the count for a track that is the list one for one', () => {
    const exact = createPlaylistSuggestionSource({
      playlistUuid: 'playlist:p',
      activatedClimb: climbs[1],
      climbs,
      boardKey: 'k',
      label: 'Projects',
      total: 4,
    });
    expect(resolveTrackLabel(exact, 'c')).toEqual({ kind: 'counted', name: 'Projects', position: 3, total: 4 });
  });
});

// Issue #6777: while a queued climb plays in the middle of a list, the top bar
// says "Up next · 1 of 3" and the list's own label comes back after.
describe('resolveUpNextTrackLabel', () => {
  const climbs = [makeClimb('a'), makeClimb('b')];
  const named = createPlaylistSuggestionSource({
    playlistUuid: 'search',
    activatedClimb: climbs[0],
    climbs,
    boardKey: 'k',
    label: '  Search results ',
  });

  it('carries the stretch of Up next and the list it returns to', () => {
    expect(resolveUpNextTrackLabel(named, { position: 1, total: 3 })).toEqual({
      kind: 'upNext',
      listName: 'Search results',
      count: { position: 1, total: 3 },
    });
  });

  it('still says Up next for a list nobody named, and without a count', () => {
    const unnamed = createPlaylistSuggestionSource({
      playlistUuid: 'feed',
      activatedClimb: climbs[0],
      climbs,
      boardKey: 'k',
    });
    expect(resolveUpNextTrackLabel(unnamed, null)).toEqual({ kind: 'upNext', listName: null, count: null });
  });
});

describe('trackLabelListName', () => {
  it('names the list whichever way the label reads', () => {
    expect(trackLabelListName({ kind: 'hidden' })).toBeNull();
    expect(trackLabelListName({ kind: 'named', name: 'Projects' })).toBe('Projects');
    expect(trackLabelListName({ kind: 'counted', name: 'Projects', position: 1, total: 2 })).toBe('Projects');
    expect(trackLabelListName({ kind: 'upNext', listName: 'Projects', count: null })).toBe('Projects');
    expect(trackLabelListName({ kind: 'upNext', listName: null, count: null })).toBeNull();
  });
});
