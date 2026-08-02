import { describe, expect, it } from 'vite-plus/test';
import { isBoardCreatePath, isBoardListPath, isBoardRoutePath } from '../board-route-paths';

describe('board-route-paths', () => {
  describe('isBoardRoutePath', () => {
    it('detects slug-based board routes', () => {
      expect(isBoardRoutePath('/b/test-board/40/list')).toBe(true);
    });

    it('detects board-name routes', () => {
      expect(isBoardRoutePath('/kilter/1/1/default/40/list')).toBe(true);
    });

    it('detects new aurora board routes', () => {
      expect(isBoardRoutePath('/grasshopper/2020/grandmaster-12-x-12/power_flow_engage/40/list')).toBe(true);
      expect(isBoardRoutePath('/decoy/dungeon-trainer/12x12/foundation/40/list')).toBe(true);
    });

    it('rejects non-board routes', () => {
      expect(isBoardRoutePath('/playlists')).toBe(false);
    });

    it('detects locale-prefixed board routes (es, fr, de)', () => {
      expect(isBoardRoutePath('/es/kilter/1/1/default/40/list')).toBe(true);
      expect(isBoardRoutePath('/fr/b/test-board/40/list')).toBe(true);
      expect(isBoardRoutePath('/de/kilter/1/1/default/40/list')).toBe(true);
    });

    it('does not treat the default (en-US) locale as a path prefix or a board', () => {
      // en-US is served at the root with no prefix, so a bare `/en-US/...`
      // never appears; and `en-US` is not a board name.
      expect(isBoardRoutePath('/en-US/kilter/1/1/default/40/list')).toBe(false);
      expect(isBoardRoutePath('/es/playlists')).toBe(false);
    });
  });

  describe('isBoardListPath', () => {
    it('matches slug-based board list routes', () => {
      expect(isBoardListPath('/b/test-board/40/list')).toBe(true);
    });

    it('matches board-name list routes', () => {
      expect(isBoardListPath('/kilter/1/1/default/40/list')).toBe(true);
    });

    it('matches new aurora board list routes', () => {
      expect(isBoardListPath('/grasshopper/2020/grandmaster-12-x-12/power_flow_engage/40/list')).toBe(true);
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

  describe('isBoardCreatePath', () => {
    it('matches slug-based board create routes', () => {
      expect(isBoardCreatePath('/b/test-board/40/create')).toBe(true);
    });

    it('matches board-name create routes', () => {
      expect(isBoardCreatePath('/moonboard/moonboard-2024/standard-11x18-grid/wooden-holds/40/create')).toBe(true);
    });

    it('rejects non-create board routes', () => {
      expect(isBoardCreatePath('/b/test-board/40/list')).toBe(false);
      expect(isBoardCreatePath('/moonboard/moonboard-2024/standard-11x18-grid/wooden-holds/40/view/climb-123')).toBe(
        false,
      );
    });
  });
});
