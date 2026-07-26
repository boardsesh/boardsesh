import { describe, it, expect } from 'vitest';
import {
  resolveUpstreamPlaylistWrite,
  canWriteUpstreamPlaylist,
  upstreamPlaylistSkipLogLine,
} from './upstream-playlist-ownership';

const USER_A = 'user-a';
const USER_B = 'user-b';

describe('resolveUpstreamPlaylistWrite', () => {
  it('returns adopt when no playlist row matched the upstream id', () => {
    expect(resolveUpstreamPlaylistWrite([], USER_A)).toBe('adopt');
  });

  it('returns adopt for an orphaned playlist with no owner edge', () => {
    // Same empty-owner shape as "no row": a playlist whose ownership rows were
    // deleted is claimable, not foreign.
    expect(resolveUpstreamPlaylistWrite([], USER_B)).toBe('adopt');
  });

  it('returns own when this user is the sole owner', () => {
    expect(resolveUpstreamPlaylistWrite([USER_A], USER_A)).toBe('own');
  });

  it('returns own when the join fanned the same owner out more than once', () => {
    expect(resolveUpstreamPlaylistWrite([USER_A, USER_A, USER_A], USER_A)).toBe('own');
  });

  it('returns foreign when a different user is the sole owner', () => {
    expect(resolveUpstreamPlaylistWrite([USER_A], USER_B)).toBe('foreign');
  });

  it('returns foreign when several other users own it and this one does not', () => {
    expect(resolveUpstreamPlaylistWrite([USER_A, 'user-c'], USER_B)).toBe('foreign');
  });

  it('returns ambiguous for an already cross-linked playlist this user co-owns', () => {
    expect(resolveUpstreamPlaylistWrite([USER_A, USER_B], USER_B)).toBe('ambiguous');
    expect(resolveUpstreamPlaylistWrite([USER_A, USER_B], USER_A)).toBe('ambiguous');
  });
});

describe('canWriteUpstreamPlaylist', () => {
  it('permits adopt and own', () => {
    expect(canWriteUpstreamPlaylist('adopt')).toBe(true);
    expect(canWriteUpstreamPlaylist('own')).toBe(true);
  });

  it('refuses foreign and ambiguous', () => {
    expect(canWriteUpstreamPlaylist('foreign')).toBe(false);
    expect(canWriteUpstreamPlaylist('ambiguous')).toBe(false);
  });
});

describe('upstreamPlaylistSkipLogLine', () => {
  it('names the column, the upstream id and the skipped user', () => {
    const line = upstreamPlaylistSkipLogLine({
      syncTag: 'kilter-sync',
      upstreamIdColumn: 'kilter_id',
      upstreamId: 'circuit-1',
      syncingUserId: USER_B,
      decision: 'foreign',
    });
    expect(line).toContain('[kilter-sync]');
    expect(line).toContain('kilter_id circuit-1');
    expect(line).toContain(USER_B);
    expect(line).toContain('already owned by a different Boardsesh user');
  });

  it('distinguishes the already-cross-linked case', () => {
    const line = upstreamPlaylistSkipLogLine({
      syncTag: 'aurora-sync',
      upstreamIdColumn: 'aurora_id',
      upstreamId: 'circuit-2',
      syncingUserId: USER_A,
      decision: 'ambiguous',
    });
    expect(line).toContain('two owners');
    expect(line).not.toContain('already owned by a different Boardsesh user');
  });
});
