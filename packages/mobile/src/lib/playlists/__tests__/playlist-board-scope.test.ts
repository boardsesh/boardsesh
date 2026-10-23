import { describe, expect, it } from 'vitest';
import { PLAYLIST_ACTIVE_BOARD_ONLY_CHIPS, playlistSheetSections } from '../playlist-board-scope';

describe('playlist board scope', () => {
  it('drops the chips whose filter needs an active board, and keeps the rest', () => {
    expect([...PLAYLIST_ACTIVE_BOARD_ONLY_CHIPS].sort()).toEqual(['beta', 'boardFit', 'progress']);
  });

  it('hides the rows a playlist never offers, board or not', () => {
    for (const hasActiveBoard of [true, false]) {
      expect(playlistSheetSections(hasActiveBoard)).toMatchObject({
        recent: false,
        drafts: false,
        setters: false,
        holds: false,
        zone: false,
        otherAngles: false,
      });
    }
  });

  it('hides progress, Liked, Following and beta videos only without an active board', () => {
    expect(playlistSheetSections(true)).not.toHaveProperty('progress');
    expect(playlistSheetSections(false)).toMatchObject({
      progress: false,
      liked: false,
      following: false,
      beta: false,
    });
  });

  it('hands back the same object each time, so the sheet props stay put', () => {
    expect(playlistSheetSections(false)).toBe(playlistSheetSections(false));
    expect(playlistSheetSections(true)).toBe(playlistSheetSections(true));
  });
});
