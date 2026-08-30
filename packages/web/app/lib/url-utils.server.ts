import 'server-only';
import { cache } from 'react';
import { notFound, permanentRedirect } from 'next/navigation';
import type {
  BoardRouteParameters,
  ParsedBoardRouteParametersWithUuid,
  ParsedBoardRouteParameters,
  BoardRouteParametersWithUuid,
  BoardName,
} from '@/app/lib/types';
import { getLayoutBySlug, getSizeBySlug, getSetsBySlug } from './slug-utils';
import {
  isNumericId,
  extractUuidFromSlug,
  hasOnlyNumericBoardRouteSegments,
  parseBoardRouteParams,
  getMoonBoardLayoutBySlug,
} from './url-utils';
import {
  generateLayoutSlug,
  generateSetNameSlug,
  generateSetSlug,
  generateSizeSlug,
} from '@boardsesh/play-view/readable-url-utils';
import { type MoonBoardLayoutKey, MOONBOARD_LAYOUTS, MOONBOARD_SETS, MOONBOARD_SIZE } from './moonboard-config';
import { WOODS_LAYOUTS, WOODS_SETS, WOODS_SIZES } from './woods-config';
import { supportsStaticBoardRender } from '@boardsesh/board-config';

// Helper to parse MoonBoard size slug (always returns the single size)
function getMoonBoardSizeBySlug(): { id: number; name: string } {
  return { id: MOONBOARD_SIZE.id, name: MOONBOARD_SIZE.name };
}

/**
 * A MoonBoard set slug back to the exact set ids it was built from.
 *
 * Generate-and-compare, the same rule the Expo app already ships
 * (`resolveMoonBoardSegmentsToIds`, `readable-url-utils.ts`): split the slug on
 * `_` — the separator `generateSetSlug` joins with — pick the layout's sets
 * whose `generateSetNameSlug` is one of those parts, then accept only if
 * re-emitting the selection rebuilds the incoming slug byte for byte.
 *
 * The rule this replaces split on `-` and substring-matched the pieces against
 * set names, so it could not tell one subset from another. Two concrete
 * failures it produced on every www MoonBoard URL: `generateSetNameSlug('Screw-on
 * Feet')` is `screw`, which a `-`-split never yields as a standalone part, so
 * masters-2017's own full-set slug parsed back WITHOUT set 15 and masters-2019's
 * without set 20 — and `generateMetadata` then emitted a `<link rel="canonical">`
 * pointing at a different URL than the one requested. It also matched far too
 * much: `hold-set-a` contains the part `set`, which is a substring of every
 * `Hold Set *` name on the layout.
 *
 * Returning an empty array is the caller's signal to fall back to every set on
 * the layout, which keeps a hand-edited or pre-slug link rendering instead of
 * 404ing. That fallback is now the only lenient path.
 */
function getMoonBoardSetsBySlug(layoutKey: MoonBoardLayoutKey, setSlug: string): { id: number; name: string }[] {
  const sets = MOONBOARD_SETS[layoutKey] || [];
  const slugParts = new Set(setSlug.split('_'));

  const selectedSets = sets.filter((set) => slugParts.has(generateSetNameSlug(set.name)));
  if (selectedSets.length === 0) return [];
  if (generateSetSlug(selectedSets.map((set) => set.name)) !== setSlug) return [];

  return selectedSets.map((set) => ({ id: set.id, name: set.name }));
}

// Enhanced route parsing function that handles both slug and numeric formats
export async function parseBoardRouteParamsWithSlugs<T extends BoardRouteParameters>(
  params: T,
): Promise<T extends BoardRouteParametersWithUuid ? ParsedBoardRouteParametersWithUuid : ParsedBoardRouteParameters> {
  const { board_name, layout_id, size_id, set_ids, angle, climb_uuid } = params;
  if (!supportsStaticBoardRender(board_name)) {
    return notFound();
  }
  const isFullyNumericFormat = hasOnlyNumericBoardRouteSegments(params);

  let parsedLayoutId: number;
  let parsedSizeId: number;
  let parsedSetIds: number[];

  // Handle MoonBoard separately (uses static config instead of database)
  if (board_name === 'moonboard') {
    // Handle layout_id (slug or numeric)
    if (isFullyNumericFormat && isNumericId(layout_id)) {
      parsedLayoutId = Number(layout_id);
    } else {
      const layout = getMoonBoardLayoutBySlug(layout_id);
      if (!layout) {
        return notFound();
      }
      parsedLayoutId = layout.id;
    }

    // Handle size_id (slug or numeric) - MoonBoard has single size
    if (isFullyNumericFormat && isNumericId(size_id)) {
      parsedSizeId = Number(size_id);
    } else {
      const size = getMoonBoardSizeBySlug();
      parsedSizeId = size.id;
    }

    // Handle set_ids (slug or numeric)
    const decodedSetIds = decodeURIComponent(set_ids);
    if (isFullyNumericFormat && isNumericId(decodedSetIds.split(',')[0])) {
      parsedSetIds = decodedSetIds.split(',').map((id) => Number(id));
    } else {
      // Find the layout key to get sets
      const layoutEntry = Object.entries(MOONBOARD_LAYOUTS).find(([, l]) => l.id === parsedLayoutId);
      if (!layoutEntry) {
        return notFound();
      }
      const layoutKey = layoutEntry[0] as MoonBoardLayoutKey;
      const sets = getMoonBoardSetsBySlug(layoutKey, decodedSetIds);
      if (sets.length === 0) {
        // If no match, try to get all sets for this layout
        const allSets = MOONBOARD_SETS[layoutKey] || [];
        parsedSetIds = allSets.map((s) => s.id);
      } else {
        parsedSetIds = sets.map((set) => set.id);
      }
    }

    const parsedParams = {
      board_name: board_name as BoardName,
      layout_id: parsedLayoutId,
      size_id: parsedSizeId,
      set_ids: parsedSetIds,
      angle: Number(angle),
    };

    if (climb_uuid) {
      return {
        ...parsedParams,
        climb_uuid: extractUuidFromSlug(climb_uuid),
      } as T extends BoardRouteParametersWithUuid ? ParsedBoardRouteParametersWithUuid : never;
    }

    return parsedParams as T extends BoardRouteParametersWithUuid ? never : ParsedBoardRouteParameters;
  }

  // Handle Woods separately (static config, single layout, one synthetic set).
  if (board_name === 'woods') {
    // Every Woods segment is validated against the static catalogue and a miss is
    // a 404, the way the MoonBoard block above 404s an unknown layout. Woods has
    // exactly one (layout, size, set) catalogue, so a segment outside it names a
    // board that does not exist — passing it through instead made
    // `getWoodsBoardDetails` throw on an unknown size id (a 500 on `/woods/1/99/…`)
    // or silently render the wrong board for an unknown size slug.

    // Woods ships a single layout, so its numeric id and its name slug
    // (`original`) both land on it.
    const decodedLayoutId = decodeURIComponent(layout_id).toLowerCase();
    if (
      decodedLayoutId !== String(WOODS_LAYOUTS.woods.id) &&
      decodedLayoutId !== generateLayoutSlug(WOODS_LAYOUTS.woods.name)
    ) {
      return notFound();
    }
    parsedLayoutId = WOODS_LAYOUTS.woods.id;

    // Size: the numeric id ('1' / '2'), the dimension slug `generateSizeSlug`
    // emits ('8x10' / '12x12'), or its dashed variant ('8-10' / '12-12').
    const decodedSizeId = decodeURIComponent(size_id).toLowerCase();
    const matchedSize = Object.values(WOODS_SIZES).find((size) => {
      const dimensionSlug = generateSizeSlug(size.name);
      return (
        decodedSizeId === String(size.id) ||
        decodedSizeId === dimensionSlug ||
        decodedSizeId === dimensionSlug.replace('x', '-')
      );
    });
    if (!matchedSize) {
      return notFound();
    }
    parsedSizeId = matchedSize.id;

    // Woods has one synthetic hold set, so `standard`, `1` and an empty segment
    // all resolve to it — and nothing else does, since there is no second set to
    // combine it with. An empty set list would break the board builder and the
    // `board/layout/size/sets/angle` path parser, so the empty segment resolves
    // to the set rather than to nothing.
    const decodedSetIds = decodeURIComponent(set_ids).toLowerCase();
    const woodsSetIds = WOODS_SETS.map((set) => set.id);
    if (
      decodedSetIds !== '' &&
      decodedSetIds !== woodsSetIds.join(',') &&
      decodedSetIds !== generateSetSlug(WOODS_SETS.map((set) => set.name))
    ) {
      return notFound();
    }
    parsedSetIds = woodsSetIds;

    const parsedParams = {
      board_name: board_name as BoardName,
      layout_id: parsedLayoutId,
      size_id: parsedSizeId,
      set_ids: parsedSetIds,
      angle: Number(angle),
    };

    if (climb_uuid) {
      return {
        ...parsedParams,
        climb_uuid: extractUuidFromSlug(climb_uuid),
      } as T extends BoardRouteParametersWithUuid ? ParsedBoardRouteParametersWithUuid : never;
    }

    return parsedParams as T extends BoardRouteParametersWithUuid ? never : ParsedBoardRouteParameters;
  }

  // Aurora boards - prefer slug resolution on mixed-format routes so numeric-looking
  // slugs like grasshopper's `2020` are treated as slugs, not numeric IDs.
  if (isFullyNumericFormat && isNumericId(layout_id)) {
    parsedLayoutId = Number(layout_id);
  } else {
    const layout = await getLayoutBySlug(board_name as BoardName, layout_id);
    if (layout) {
      parsedLayoutId = layout.id;
    } else if (isNumericId(layout_id)) {
      parsedLayoutId = Number(layout_id);
    } else {
      return notFound();
    }
  }

  // Handle size_id (slug or numeric)
  if (isFullyNumericFormat && isNumericId(size_id)) {
    parsedSizeId = Number(size_id);
  } else {
    const size = await getSizeBySlug(board_name as BoardName, parsedLayoutId, size_id);
    if (size) {
      parsedSizeId = size.id;
    } else if (isNumericId(size_id)) {
      parsedSizeId = Number(size_id);
    } else {
      return notFound();
    }
  }

  // Handle set_ids (slug or numeric)
  const decodedSetIds = decodeURIComponent(set_ids);
  if (isFullyNumericFormat && isNumericId(decodedSetIds.split(',')[0])) {
    parsedSetIds = decodedSetIds.split(',').map((id) => Number(id));
  } else {
    const sets = await getSetsBySlug(board_name as BoardName, parsedLayoutId, parsedSizeId, decodedSetIds);
    if (sets && sets.length > 0) {
      parsedSetIds = sets.map((set) => set.id);
    } else if (decodedSetIds.split(',').every((id) => isNumericId(id.trim()))) {
      parsedSetIds = decodedSetIds.split(',').map((id) => Number(id));
    } else {
      return notFound();
    }
  }

  const parsedParams = {
    board_name,
    layout_id: parsedLayoutId,
    size_id: parsedSizeId,
    set_ids: parsedSetIds,
    angle: Number(angle),
  };

  if (climb_uuid) {
    return {
      ...parsedParams,
      climb_uuid: extractUuidFromSlug(climb_uuid),
    } as T extends BoardRouteParametersWithUuid ? ParsedBoardRouteParametersWithUuid : never;
  }

  return parsedParams as T extends BoardRouteParametersWithUuid ? never : ParsedBoardRouteParameters;
}

/**
 * Checks whether route parameters contain numeric IDs (old URL format) vs slugs (new format),
 * then parses them accordingly. Returns both the parsed params and a flag indicating the format.
 *
 * This consolidates the repeated hasNumericParams + parse pattern used across route files.
 */
async function parseRouteParamsImpl<T extends BoardRouteParameters>(
  params: T,
): Promise<{
  parsedParams: T extends BoardRouteParametersWithUuid
    ? ParsedBoardRouteParametersWithUuid
    : ParsedBoardRouteParameters;
  isNumericFormat: boolean;
}> {
  if (!supportsStaticBoardRender(params.board_name)) {
    return notFound();
  }
  const isNumericFormat = hasOnlyNumericBoardRouteSegments(params);

  if (isNumericFormat) {
    // For UUID routes, extract the UUID from the slug before parsing
    const paramsToPass = (params as BoardRouteParametersWithUuid).climb_uuid
      ? {
          ...params,
          climb_uuid: extractUuidFromSlug((params as BoardRouteParametersWithUuid).climb_uuid),
        }
      : params;

    const parsedParams = parseBoardRouteParams(paramsToPass);
    const hasInvalidNumericIds =
      Number.isNaN(parsedParams.layout_id) ||
      Number.isNaN(parsedParams.size_id) ||
      Number.isNaN(parsedParams.angle) ||
      parsedParams.set_ids.some((id) => Number.isNaN(id));

    if (hasInvalidNumericIds) {
      return {
        parsedParams: await parseBoardRouteParamsWithSlugs(params),
        isNumericFormat: false,
      };
    }

    return {
      parsedParams,
      isNumericFormat: true,
    };
  }

  return {
    parsedParams: await parseBoardRouteParamsWithSlugs(params),
    isNumericFormat: false,
  };
}

export const parseRouteParams = cache(parseRouteParamsImpl);

/**
 * 301-redirect to `viewUrl` with the original search params reserialised onto
 * the new URL. Shared by the two `/play/[climb_uuid]` redirect pages so the
 * URLSearchParams + permanentRedirect boilerplate lives in one place.
 *
 * Never returns — `permanentRedirect` throws.
 */
export function redirectWithQuery(viewUrl: string, searchParams: Record<string, string | string[]>): never {
  const queryString = new URLSearchParams(
    Object.entries(searchParams).flatMap(([key, value]) =>
      Array.isArray(value) ? value.map((v) => [key, v] as [string, string]) : [[key, value] as [string, string]],
    ),
  ).toString();
  permanentRedirect(queryString ? `${viewUrl}?${queryString}` : viewUrl);
}
