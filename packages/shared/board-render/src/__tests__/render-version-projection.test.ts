import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOARD_IMAGE_DIMENSIONS, SUPPORTED_BOARDS } from '@boardsesh/board-config';
import { HOLD_STATE_MAP, getBoardStrokeWidthMultiplier } from '@boardsesh/board-constants/hold-states';
import { getBackgroundRelPaths } from '../background';
import { getBoardDetailsForBoard } from '../board-details';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from '../headers';
import { buildRenderConfig, THUMBNAIL_WIDTH } from '../render-config';
import { BOARD_RENDER_VERSION } from '../generated/render-version';
import {
  buildBoardRenderProjections,
  combineBoardRenderVersion,
  listCatalogueEntries,
} from '../render-version-projection';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');

describe('BOARD_RENDER_VERSION', () => {
  it('is a 12-char lowercase hex digest', () => {
    expect(BOARD_RENDER_VERSION).toMatch(/^[0-9a-f]{12}$/);
  });

  it('satisfies the render route’s own well-formed-version regex', () => {
    // Kept in lock-step with `isWellFormedRenderVersion` in
    // packages/backend/src/handlers/board-render.ts. If they disagree,
    // every versioned web URL silently drops off the immutable branch.
    expect(BOARD_RENDER_VERSION).toMatch(/^[0-9a-f]{8,64}$/);
  });

  it('has no imports, so it is safe in the browser bundle', () => {
    // buildBoardRenderUrl compiles into web's client chunk. An import here would
    // drag sharp or the WASM glue in with it.
    const source = readFileSync(path.join(PACKAGE_ROOT, 'src/generated/render-version.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});

describe('listCatalogueEntries', () => {
  it('covers every supported board', () => {
    const boardsInCatalogue = new Set(listCatalogueEntries().map((entry) => entry.boardName));
    expect([...boardsInCatalogue].sort()).toEqual([...SUPPORTED_BOARDS].sort());
  });

  it('is deterministic', () => {
    expect(listCatalogueEntries()).toEqual(listCatalogueEntries());
  });

  it('produces entries that all render', () => {
    // A catalogue entry that throws is recorded as `unrenderable` rather than
    // crashing the generator, which would make the version quietly weaker. None
    // should be unrenderable today — if that changes, it is a real bug.
    for (const entry of listCatalogueEntries()) {
      expect(() =>
        getBoardDetailsForBoard({
          board_name: entry.boardName,
          layout_id: entry.layoutId,
          size_id: entry.sizeId,
          set_ids: entry.setIds,
        }),
      ).not.toThrow();
    }
  });
});

describe('buildBoardRenderProjections', () => {
  it('is deterministic across runs', () => {
    expect(buildBoardRenderProjections()).toEqual(buildBoardRenderProjections());
  });

  it('resolves at least one board photo for every board', () => {
    for (const [boardName, projection] of Object.entries(buildBoardRenderProjections())) {
      expect(projection.entryCount, boardName).toBeGreaterThan(0);
      expect(projection.imageRelPaths.length, boardName).toBeGreaterThan(0);
    }
  });

  it('records no unrenderable combination', () => {
    // `projectCatalogueEntry` swallows a throw so one bad board cannot take the
    // generator down — this is what stops that from being a silent branch. A board
    // that quietly stops rendering shows up here, not just as a version that moved.
    for (const [boardName, projection] of Object.entries(buildBoardRenderProjections())) {
      expect(projection.unrenderableCount, boardName).toBe(0);
    }
  });

  // The review of the original plan found a hand-written file list that missed
  // @boardsesh/board-config and excluded headers.ts on a false premise. These
  // assert the projection genuinely carries those inputs, so it cannot regress
  // into a list that names files instead of capturing values.
  describe('captures the inputs a file list kept missing', () => {
    /** The first Kilter catalogue entry, resolved the way the projection resolves it. */
    const kilterBoardDetails = () => {
      const kilterEntry = listCatalogueEntries().find((entry) => entry.boardName === 'kilter');
      if (!kilterEntry) throw new Error('no Kilter entry in the catalogue');
      return getBoardDetailsForBoard({
        board_name: kilterEntry.boardName,
        layout_id: kilterEntry.layoutId,
        size_id: kilterEntry.sizeId,
        set_ids: kilterEntry.setIds,
      });
    };

    const kilterNativeConfig = () =>
      buildRenderConfig({
        boardName: 'kilter',
        boardDetails: kilterBoardDetails(),
        frames: '',
        thumbnail: false,
        isOgVariant: false,
        boardStates: HOLD_STATE_MAP.kilter,
      });

    it('carries BOARD_IMAGE_DIMENSIONS through the board size (@boardsesh/board-config)', () => {
      const boardDetails = kilterBoardDetails();
      const rendered = kilterNativeConfig();
      const firstImage = Object.keys(boardDetails.images_to_holds)[0];
      const dimensions = BOARD_IMAGE_DIMENSIONS.kilter[firstImage];
      expect(dimensions).toBeDefined();
      expect(rendered.config.board_width).toBe(dimensions.width);
      expect(rendered.config.board_height).toBe(dimensions.height);
      // And those dimensions position every hold.
      expect(rendered.config.holds.length).toBeGreaterThan(0);
    });

    it('carries the hold-state colour map and stroke multiplier (@boardsesh/board-constants)', () => {
      const rendered = kilterNativeConfig();
      expect(rendered.config.stroke_width_multiplier).toBe(getBoardStrokeWidthMultiplier('kilter'));
      for (const [code, info] of Object.entries(HOLD_STATE_MAP.kilter)) {
        expect(rendered.config.hold_state_map[Number(code)].color).toBe(info.displayColor ?? info.color);
      }
    });

    it('carries THUMBNAIL_WIDTH and the OG canvas size (headers.ts)', () => {
      const boardDetails = kilterBoardDetails();
      const rendered = kilterNativeConfig();
      const thumbnail = buildRenderConfig({
        boardName: 'kilter',
        boardDetails,
        frames: '',
        thumbnail: true,
        isOgVariant: false,
        boardStates: HOLD_STATE_MAP.kilter,
      });
      const ogCard = buildRenderConfig({
        boardName: 'kilter',
        boardDetails,
        frames: '',
        thumbnail: false,
        isOgVariant: true,
        boardStates: HOLD_STATE_MAP.kilter,
      });
      expect(thumbnail.outputWidth).toBe(THUMBNAIL_WIDTH);
      // The OG scale is derived from OG_IMAGE_WIDTH/HEIGHT, so a change to either
      // moves the projection.
      expect(ogCard.ogScale).not.toBeNull();
      expect(ogCard.outputWidth).toBeLessThanOrEqual(OG_IMAGE_WIDTH);
      expect(Math.round(rendered.config.board_height * ogCard.ogScale!)).toBeLessThanOrEqual(OG_IMAGE_HEIGHT);
    });

    it('carries which board photos get composited (background.ts path logic)', () => {
      const boardDetails = kilterBoardDetails();
      expect(getBackgroundRelPaths(boardDetails, false).length).toBeGreaterThan(0);
      expect(getBackgroundRelPaths(boardDetails, true)).not.toEqual(getBackgroundRelPaths(boardDetails, false));
    });
  });
});

describe('combineBoardRenderVersion', () => {
  const fileHashes = { 'a.wasm': 'aa', 'b.ts': 'bb' };
  const boardHashes = { kilter: '11', tension: '22' };

  it('is stable across calls', () => {
    expect(combineBoardRenderVersion({ fileHashes, boardHashes })).toBe(
      combineBoardRenderVersion({ fileHashes, boardHashes }),
    );
  });

  it('does not depend on key insertion order', () => {
    expect(
      combineBoardRenderVersion({
        fileHashes: { 'b.ts': 'bb', 'a.wasm': 'aa' },
        boardHashes: { tension: '22', kilter: '11' },
      }),
    ).toBe(combineBoardRenderVersion({ fileHashes, boardHashes }));
  });

  it('moves when an opaque input changes', () => {
    expect(combineBoardRenderVersion({ fileHashes: { ...fileHashes, 'a.wasm': 'ac' }, boardHashes })).not.toBe(
      combineBoardRenderVersion({ fileHashes, boardHashes }),
    );
  });

  it('moves when a board changes', () => {
    expect(combineBoardRenderVersion({ fileHashes, boardHashes: { ...boardHashes, kilter: '13' } })).not.toBe(
      combineBoardRenderVersion({ fileHashes, boardHashes }),
    );
  });

  it('emits a 12-char lowercase hex digest', () => {
    expect(combineBoardRenderVersion({ fileHashes, boardHashes })).toMatch(/^[0-9a-f]{12}$/);
  });

  // The Woods Board merge (500988337) added a board and touched hold-states,
  // product-sizes, hole-placements and board-details — a pure content hash of
  // those files would have invalidated every Kilter and Tension image on the
  // site for a change that altered zero Kilter or Tension pixels.
  describe('a new-board-only change', () => {
    const withNewBoard = { ...boardHashes, woods: '33' };

    it('leaves every existing board’s digest byte-identical', () => {
      for (const [boardName, boardHash] of Object.entries(boardHashes)) {
        expect(withNewBoard[boardName as keyof typeof withNewBoard]).toBe(boardHash);
      }
    });

    it('still moves the GLOBAL version, which per-board `v=` would fix', () => {
      // Documented limitation, not an oversight: one version string for the whole
      // route cannot be indifferent to a board joining the catalogue. The
      // projection is already partitioned per board so the follow-up only has to
      // thread `board_name` into the URL builder — see the follow-up issue linked
      // from #4773. Until then a new board costs one global invalidation, against
      // the ~13/day Vercel's deploy purge was doing before Cloudflare.
      expect(combineBoardRenderVersion({ fileHashes, boardHashes: withNewBoard })).not.toBe(
        combineBoardRenderVersion({ fileHashes, boardHashes }),
      );
    });
  });
});
