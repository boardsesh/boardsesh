import type { BoardName } from '@boardsesh/shared-schema';
import { BOARD_RENDER_VERSION } from '@boardsesh/board-render/version';
import type { HoldGeometryInput } from '@boardsesh/board-render/render-config';
import { getBoardGeometryEndpoint } from '@/app/components/board-renderer/util';

/**
 * The traced board art for one board config, fetched rather than bundled.
 *
 * `@boardsesh/board-art-geometry` ships 51 shards behind an index of literal
 * `require`s, so importing it here would put 5.2 MB of polygons in the client
 * bundle to draw one board. The backend hands over the single config instead
 * (`GET /render/geometry`), immutably cached under the same `v=` the images
 * carry — 43 KB gzipped at the very worst, and once per board config per
 * session.
 *
 * Every failure resolves to `null`, never rejects. Aura without silhouettes is
 * the Modern Classic drawing, which is a worse picture but a complete one; a
 * board that will not render at all because a JSON fetch failed is not.
 */

/**
 * What `/render/geometry` returns. Every field is absent for a config the tracer
 * skipped.
 *
 * Keyed by `string`, not `number`: JSON object keys are always strings, and
 * typing them as numbers would be a lie about the value in hand. The renderer's
 * `HoldGeometryInput` declares `Record<number, …>` because its other producer
 * (the backend, reading the shards directly) really does hand over numeric keys
 * — and JS property access coerces either way, so `outlines[hold.id]` finds the
 * same entry in both. The cast at the boundary below is where the two meet.
 */
type BoardGeometryResponse = {
  outlines?: Record<string, number[]>;
  ledInner?: Record<string, number[]>;
  ledBright?: Record<string, [number, number]>;
  silhouetteLightness?: Record<string, number>;
  wallLightness?: { mean: number; coverage: number };
};

export type BoardGeometry = {
  holdGeometry: HoldGeometryInput;
  wallLightness: { mean: number; coverage: number } | null;
};

export type BoardGeometryQuery = { boardName: BoardName; layoutId: number; sizeId: number };

const geometryCache = new Map<string, Promise<BoardGeometry | null>>();

function geometryKey({ boardName, layoutId, sizeId }: BoardGeometryQuery): string {
  return `${boardName}/${layoutId}-${sizeId}`;
}

async function fetchBoardGeometry(query: BoardGeometryQuery): Promise<BoardGeometry> {
  const params = new URLSearchParams({
    board_name: query.boardName,
    layout_id: String(query.layoutId),
    size_id: String(query.sizeId),
    v: BOARD_RENDER_VERSION,
  });
  const response = await fetch(`${getBoardGeometryEndpoint()}?${params}`);
  if (!response.ok) throw new Error(`board geometry request failed: ${response.status}`);
  const payload = (await response.json()) as BoardGeometryResponse;
  return {
    // See `BoardGeometryResponse`: JSON hands back string keys, the renderer's
    // input type names numbers, and property access resolves both to the same
    // entry. Cast field by field rather than casting the object, so the shape of
    // `HoldGeometryInput` is still checked and only the key type is waived.
    holdGeometry: {
      outlines: payload.outlines as HoldGeometryInput['outlines'],
      ledInner: payload.ledInner as HoldGeometryInput['ledInner'],
      ledBright: payload.ledBright as HoldGeometryInput['ledBright'],
      silhouetteLightness: payload.silhouetteLightness as HoldGeometryInput['silhouetteLightness'],
    },
    wallLightness: payload.wallLightness ?? null,
  };
}

/**
 * Memoised per board config, on the promise rather than the result, so fifty
 * climb cards mounting at once share one request.
 *
 * Only successes are kept. A failed fetch drops out of the cache so the next
 * card to mount tries again — memoising the `null` would let one cold-backend
 * moment at page load cost every board on the page its silhouettes for the rest
 * of the session, with no way back short of a reload.
 */
export function loadBoardGeometry(query: BoardGeometryQuery): Promise<BoardGeometry | null> {
  const key = geometryKey(query);
  const cached = geometryCache.get(key);
  if (cached) return cached;

  const pending = fetchBoardGeometry(query).catch(() => {
    geometryCache.delete(key);
    return null;
  });
  geometryCache.set(key, pending);
  return pending;
}

/** Tests only: forget the in-flight and resolved geometry between cases. */
export function resetBoardGeometryCache(): void {
  geometryCache.clear();
}
