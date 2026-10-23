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
        otherAngles: false,
      });
    }
  });

  it('offers the Setters, Hold types and Board region pickers on an active board', () => {
    const sections = playlistSheetSections(true);
    expect(sections).not.toHaveProperty('setters');
    expect(sections).not.toHaveProperty('holds');
    expect(sections).not.toHaveProperty('zone');
  });

  it('hides the board-only rows without an active board, and keeps Setters, which reads every row', () => {
    const sections = playlistSheetSections(false);
    expect(playlistSheetSections(true)).not.toHaveProperty('progress');
    expect(sections).toMatchObject({
      progress: false,
      liked: false,
      following: false,
      beta: false,
      holds: false,
      zone: false,
    });
    expect(sections).not.toHaveProperty('setters');
  });

  it('hands back the same object each time, so the sheet props stay put', () => {
    expect(playlistSheetSections(false)).toBe(playlistSheetSections(false));
    expect(playlistSheetSections(true)).toBe(playlistSheetSections(true));
  });
});
