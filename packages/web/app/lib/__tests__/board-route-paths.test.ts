import { describe, expect, it } from 'vitest';
import { isBoardListPath, isBoardRoutePath } from '../board-route-paths';

describe('board-route-paths', () => {
  describe('isBoardRoutePath', () => {
    it('detects slug-based board routes', () => {
      expect(isBoardRoutePath('/b/test-board/40/list')).toBe(true);
    });

    it('detects board-name routes', () => {
      expect(isBoardRoutePath('/kilter/1/1/default/40/list')).toBe(true);
    });

    it('rejects non-board routes', () => {
      expect(isBoardRoutePath('/playlists')).toBe(false);
    });
  });

  describe('isBoardListPath', () => {
    it('matches slug-based board list routes', () => {
      expect(isBoardListPath('/b/test-board/40/list')).toBe(true);
    });

    it('matches board-name list routes', () => {
      expect(isBoardListPath('/kilter/1/1/default/40/list')).toBe(true);
    });

    it('rejects non-list board routes', () => {
      expect(isBoardListPath('/b/test-board/40/view/climb-123')).toBe(false);
      expect(isBoardListPath('/kilter/1/1/default/40/play/climb-123')).toBe(false);
    });

    it('rejects longer paths that only contain a list segment', () => {
      expect(isBoardListPath('/b/test-board/40/list/extra')).toBe(false);
      expect(isBoardListPath('/kilter/1/1/default/40/list/extra')).toBe(false);
    });

    it('rejects lookalike segments', () => {
      expect(isBoardListPath('/b/test-board/list-item/123')).toBe(false);
    });
  });
});
