import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { SPRAY_SET_IDS, spraySizeIdForLayout } from '@boardsesh/board-config';
import {
  HOLD_STATE_MAP,
  STATE_TO_PRIMARY_CODE,
  encodeMapsToFramesString,
} from '@boardsesh/board-constants/hold-states';
import type { LitUpHoldsMap } from '@boardsesh/shared-schema';
import { getBoardRenderData } from '../lib/board-details';
import { SPRAY_BOARD_NAME, sprayCacheToken, subscribeToSprayWalls } from '../lib/spray/spray-wall-registry';
import {
  DEFAULT_SPRAY_WALL_PREVIEW_HOLD_COUNT,
  previewRolesBottomToTop,
  samplePreviewHolds,
} from '../lib/spray/sample-preview-holds';
import type { BoardPreviewClimb } from './use-board-preview-climb';

/**
 * A preview "climb" on a spray wall that has no climbs yet: some of the wall's
 * own holds, lit as a stand-in problem.
 *
 * The spray-wall look step's counterpart to `useBoardPreviewClimb`, and the same
 * shape, so `BoardLookCarousel` and `BoardPreviewSheet` take it unchanged. That
 * hook is the wrong source here twice over: it draws the ACTIVE board, and the
 * wall being created is not bound as active until it publishes; and it searches
 * for the board's most-climbed problem, which a wall made a minute ago does not
 * have.
 *
 * Reads the wall out of the spray registry — whatever version the caller put
 * there; the look step registers the draft through `useSprayWallDraft` — and
 * subscribes to it, so the preview appears the moment the registration lands
 * and follows it if it is replaced. Deliberately does NOT ask the loader for the
 * wall (`ensureSprayWallLoaded`): that fetches the PUBLISHED version, which a
 * wall still being created does not have.
 *
 * `loading` while the wall is not registered; the caller owns telling that apart
 * from a draft that cannot be drawn at all (`useSprayWallDraft().isUnavailable`).
 */
export function useSyntheticSprayWallPreview(
  layoutId: number | null,
  targetCount: number = DEFAULT_SPRAY_WALL_PREVIEW_HOLD_COUNT,
): BoardPreviewClimb {
  // `-sv<version>` while a wall is registered, `-sv0` while it is not: moves on
  // registration, re-registration under a new version, and unregistration.
  const sprayToken = useSyncExternalStore(
    subscribeToSprayWalls,
    useCallback(() => (layoutId == null ? '' : sprayCacheToken(SPRAY_BOARD_NAME, layoutId)), [layoutId]),
  );

  return useMemo<BoardPreviewClimb>(() => {
    if (layoutId == null) return { status: 'unavailable', preview: null };
    // Read for the memo, not used: `getBoardRenderData` keys its own cache on it.
    void sprayToken;

    const sizeId = spraySizeIdForLayout(layoutId);
    const renderData = getBoardRenderData({
      boardName: SPRAY_BOARD_NAME,
      layoutId,
      sizeId,
      setIds: [...SPRAY_SET_IDS],
    });
    if (!renderData) return { status: 'loading', preview: null };

    const sampledIds = new Set(
      samplePreviewHolds(
        renderData.holdsData.map((hold) => hold.id),
        targetCount,
      ),
    );
    // Bottom of the photo first (largest `cy`), so the stand-in climb starts low
    // and finishes high like a real one. Ties broken on id to stay deterministic.
    const sampledBottomToTop = renderData.holdsData
      .filter((hold) => sampledIds.has(hold.id))
      .sort((lower, upper) => upper.cy - lower.cy || lower.id - upper.id);
    if (sampledBottomToTop.length === 0) return { status: 'unavailable', preview: null };

    const roles = previewRolesBottomToTop(sampledBottomToTop.length);
    const roleCodes = STATE_TO_PRIMARY_CODE.spray;
    const litHolds: LitUpHoldsMap = {};
    sampledBottomToTop.forEach((hold, rank) => {
      const state = roles[rank];
      const code = roleCodes[state];
      const stateInfo = code === undefined ? undefined : HOLD_STATE_MAP.spray[code];
      if (!stateInfo) return;
      // The encoder reads only `state`; the colours are carried because the type
      // asks for them, with the map's own fallback when a role has no display one.
      litHolds[hold.id] = { state, color: stateInfo.color, displayColor: stateInfo.displayColor ?? stateInfo.color };
    });

    return {
      status: 'ready',
      preview: {
        // The shared write-side encoder, so the string is exactly what a climb
        // set on this wall would store: one absolute `p<id>r<code>` frame.
        frames: encodeMapsToFramesString([litHolds], SPRAY_BOARD_NAME),
        boardName: SPRAY_BOARD_NAME,
        layoutId,
        sizeId,
        setIds: SPRAY_SET_IDS.join(','),
        boardWidth: renderData.boardWidth,
        boardHeight: renderData.boardHeight,
      },
    };
  }, [layoutId, targetCount, sprayToken]);
}
