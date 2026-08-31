import { createHash } from 'node:crypto';
import type { BoardName } from '@boardsesh/shared-schema';
import { HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import { stableStringify } from '@boardsesh/board-constants/stable-json';
import { getAllLayouts, getSetsForLayoutAndSize, getSizesForLayoutId } from '@boardsesh/board-constants/product-sizes';
import {
  MOONBOARD_LAYOUTS,
  MOONBOARD_SETS,
  MOONBOARD_SIZE,
  STATIC_BOARD_RENDER_NAMES,
  WOODS_LAYOUTS,
  WOODS_SETS,
  WOODS_SIZES,
} from '@boardsesh/board-config';
import { getBackgroundRelPaths, OG_BOARD_PADDING_X, OG_BOARD_PADDING_Y } from './background';
import { getBoardDetailsForBoard } from './board-details';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH } from './headers';
import { buildRenderConfig } from './render-config';

/**
 * Semantic projection of everything that decides what `/api/internal/board-render`
 * draws, used to derive the `v=` cache version in the render URL (#4773).
 *
 * WHY A PROJECTION AND NOT A FILE LIST
 * ------------------------------------
 * A hand-kept list of "files that affect pixels" has no completeness proof, and
 * every draft of one written for this feature was wrong in both directions — it
 * missed `@boardsesh/board-config` (whose `BOARD_IMAGE_DIMENSIONS` positions every
 * hold) and `headers.ts` (`OG_IMAGE_WIDTH`/`HEIGHT`, which size every OG render),
 * while including `led-placements` (which the renderer never reads — see the
 * displayColor comment in `render-config.ts`). A missed input means Cloudflare
 * serves visibly wrong images `immutable` for a year.
 *
 * So instead of naming files, this walks the shipped board catalogue and records
 * the *output* of `buildRenderConfig` — which is provably the entire input to the
 * WASM renderer — plus the board photos each entry composites. That transitively
 * covers hold geometry, board dimensions, edges, hold-state colours, stroke
 * multipliers, thumbnail width, OG canvas size and MoonBoard/Woods geometry
 * without naming any of them, and it cannot rot when a new one is added.
 *
 * The two halves the projection cannot see — the compiled WASM binary and the
 * imperative sharp pipeline — stay file hashes, added by
 * `scripts/generate-board-render-version.ts`. Both are genuinely low-churn.
 *
 * NOT A CLIENT MODULE. This imports `node:crypto` and is deliberately absent from
 * the package barrel (`index.ts`), which is in web's client bundle. Only the
 * generator script and its tests import it; the browser sees the generated
 * constant in `generated/render-version.ts` instead.
 */

/** One `(board, layout, size, sets)` combination the render route can be asked for. */
export type CatalogueEntry = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: number[];
};

export type BoardRenderProjection = {
  /** SHA-256 of the deterministic JSON for everything this board renders, minus photo bytes. */
  configDigest: string;
  /** Deduped, sorted `public/`-relative board photo paths this board composites. */
  imageRelPaths: string[];
  /** Catalogue combinations that fed the digest — reported so a shrinking catalogue is visible. */
  entryCount: number;
  /**
   * Combinations that threw instead of resolving board details. Recorded rather
   * than thrown so the generator cannot be taken down by one bad board, but
   * surfaced here so the silent branch is observable: a board that quietly stops
   * rendering would otherwise only show up as a version that moved.
   */
  unrenderableCount: number;
};

const FRAMES_PROBE = '';

/**
 * Every catalogue combination the render route serves, in a fixed order.
 *
 * Aurora boards take the union of a layout+size's hold sets rather than every
 * subset: `holdsData` is a flat map over the selected sets, so the union covers
 * every hold placement and every board photo any subset could ask for, in 51
 * entries instead of a combinatorial explosion.
 */
export function listCatalogueEntries(): CatalogueEntry[] {
  const entries: CatalogueEntry[] = [];

  for (const boardName of STATIC_BOARD_RENDER_NAMES) {
    if (boardName === 'moonboard') {
      for (const [layoutKey, layout] of Object.entries(MOONBOARD_LAYOUTS)) {
        const setIds = (MOONBOARD_SETS[layoutKey as keyof typeof MOONBOARD_SETS] ?? [])
          .map((set) => set.id)
          .sort((left, right) => left - right);
        entries.push({ boardName, layoutId: layout.id, sizeId: MOONBOARD_SIZE.id, setIds });
      }
      continue;
    }

    if (boardName === 'woods') {
      const woodsSetIds = WOODS_SETS.map((set) => set.id).sort((left, right) => left - right);
      for (const size of Object.values(WOODS_SIZES)) {
        entries.push({ boardName, layoutId: WOODS_LAYOUTS.woods.id, sizeId: size.id, setIds: woodsSetIds });
      }
      continue;
    }

    for (const layout of getAllLayouts(boardName)) {
      for (const size of getSizesForLayoutId(boardName, layout.id)) {
        const setIds = getSetsForLayoutAndSize(boardName, layout.id, size.id)
          .map((set) => set.id)
          .sort((left, right) => left - right);
        entries.push({ boardName, layoutId: layout.id, sizeId: size.id, setIds });
      }
    }
  }

  return entries;
}

/**
 * Everything about one catalogue entry that decides its pixels. `frames` is held
 * at the empty string: it is a URL parameter, so it is already part of the cache
 * key and must not enter the version.
 */
function projectCatalogueEntry(entry: CatalogueEntry): Record<string, unknown> {
  const identity = {
    board_name: entry.boardName,
    layout_id: entry.layoutId,
    size_id: entry.sizeId,
    set_ids: entry.setIds,
  };

  let boardDetails;
  try {
    boardDetails = getBoardDetailsForBoard({
      board_name: entry.boardName,
      layout_id: entry.layoutId,
      size_id: entry.sizeId,
      set_ids: entry.setIds,
    });
  } catch (error) {
    // A combination that throws today renders nothing today. Record the failure
    // rather than aborting the generator: if it starts rendering later, the
    // projection changes and the version moves, which is exactly right.
    return { ...identity, unrenderable: error instanceof Error ? error.message : String(error) };
  }

  const boardStates = HOLD_STATE_MAP[entry.boardName];
  const native = buildRenderConfig({
    boardName: entry.boardName,
    boardDetails,
    frames: FRAMES_PROBE,
    thumbnail: false,
    isOgVariant: false,
    boardStates,
  });
  const thumbnail = buildRenderConfig({
    boardName: entry.boardName,
    boardDetails,
    frames: FRAMES_PROBE,
    thumbnail: true,
    isOgVariant: false,
    boardStates,
  });
  const ogCard = buildRenderConfig({
    boardName: entry.boardName,
    boardDetails,
    frames: FRAMES_PROBE,
    thumbnail: false,
    isOgVariant: true,
    boardStates,
  });

  return {
    ...identity,
    // The full WASM input for the native render: board dimensions, every hold's
    // (id, cx, cy, r), the hold-state colour map and the stroke multiplier.
    wasm_config: native.config,
    // The other two output widths, which is all the variants change in the config.
    output_width_thumbnail: thumbnail.outputWidth,
    output_width_og: ogCard.outputWidth,
    og_scale: ogCard.ogScale,
    // Pixel geometry the sharp half applies around the board photo. Implied by
    // `og_scale`, but that is a rounded ratio, so record the terms as well.
    og_canvas: [OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT],
    og_padding: [OG_BOARD_PADDING_X, OG_BOARD_PADDING_Y],
    // Which photos get composited, in order, for both the full and thumb paths.
    backgrounds_full: getBackgroundRelPaths(boardDetails, false),
    backgrounds_thumbnail: getBackgroundRelPaths(boardDetails, true),
  };
}

/**
 * Project the whole catalogue, one digest per board.
 *
 * Per-board rather than one flat digest so the partition is visible and testable:
 * adding a board leaves every other board's digest byte-identical. The shipped
 * `v=` is still global (one version for the whole route), so a new board does move
 * it — making that a non-event is what per-board `v=` would buy, tracked as a
 * follow-up.
 */
export function buildBoardRenderProjections(): Record<string, BoardRenderProjection> {
  const perBoardEntries = new Map<string, Record<string, unknown>[]>();
  for (const entry of listCatalogueEntries()) {
    const existing = perBoardEntries.get(entry.boardName);
    const projected = projectCatalogueEntry(entry);
    if (existing) existing.push(projected);
    else perBoardEntries.set(entry.boardName, [projected]);
  }

  const projections: Record<string, BoardRenderProjection> = {};
  for (const [boardName, entries] of perBoardEntries) {
    // Hashed entry by entry: the full JSON for Kilter alone is tens of MB.
    const boardHash = createHash('sha256');
    const imageRelPaths = new Set<string>();
    let unrenderableCount = 0;
    for (const projected of entries) {
      if ('unrenderable' in projected) unrenderableCount += 1;
      boardHash.update(stableStringify(projected));
      boardHash.update('\n');
      for (const key of ['backgrounds_full', 'backgrounds_thumbnail'] as const) {
        const paths = projected[key];
        if (Array.isArray(paths)) {
          for (const relPath of paths) {
            if (typeof relPath === 'string') imageRelPaths.add(relPath);
          }
        }
      }
    }

    projections[boardName] = {
      configDigest: boardHash.digest('hex'),
      imageRelPaths: [...imageRelPaths].sort(),
      entryCount: entries.length,
      unrenderableCount,
    };
  }

  return projections;
}

/** Length of the emitted version. 12 hex chars = 48 bits; collisions are not a concern at ~0.3 versions/day. */
export const BOARD_RENDER_VERSION_LENGTH = 12;

/**
 * Fold the per-board digests and the opaque-binary file hashes into the single
 * version string the URL carries. Pure and ordering-stable so the generator, the
 * drift check and the tests all agree.
 */
export function combineBoardRenderVersion(inputs: {
  /** `relative/path` → SHA-256, for the inputs no projection can see (WASM, sharp pipeline). */
  fileHashes: Record<string, string>;
  /** `board_name` → SHA-256 of its projection plus its photo bytes. */
  boardHashes: Record<string, string>;
}): string {
  const versionHash = createHash('sha256');
  // Schema tag: bump it to force a version change when the projection's shape
  // changes in a way that is not itself an input (e.g. a bug fix in this file).
  versionHash.update('board-render-version/1\n');
  for (const [relPath, fileHash] of Object.entries(inputs.fileHashes).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    versionHash.update(`file:${relPath}=${fileHash}\n`);
  }
  for (const [boardName, boardHash] of Object.entries(inputs.boardHashes).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    versionHash.update(`board:${boardName}=${boardHash}\n`);
  }
  return versionHash.digest('hex').slice(0, BOARD_RENDER_VERSION_LENGTH);
}
