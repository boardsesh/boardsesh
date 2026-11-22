import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react';
import { runOnJS, runOnUI, useAnimatedReaction, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { LOUPE_SIZE_PT } from './spray-gesture-math';
import type { SprayEditorHold } from './spray-hold-editor-reducer';
import {
  buildSprayHoldViewportIndex,
  holdsInSprayViewport,
  type HoldViewportBounds,
} from './spray-hold-viewport-index';

export const LOUPE_VIEWPORT_CELL_PT = 32;
/** Covers the non-scaling outline/halo beyond the geometry's own bounds. */
const LOUPE_VIEWPORT_HALO_PT = 8;
const NO_VISIBLE_HOLDS: readonly SprayEditorHold[] = [];

export type SprayLoupeViewport = {
  centerXSV: SharedValue<number>;
  centerYSV: SharedValue<number>;
  magnificationSV: SharedValue<number>;
  readySV: SharedValue<boolean>;
  renderWidth: number;
  renderHeight: number;
};

export const SprayLoupeViewportContext = createContext<SprayLoupeViewport | null>(null);

export function loupeViewportKey(renderX: number, renderY: number, magnification: number): string {
  'worklet';
  return `${Math.floor(renderX / LOUPE_VIEWPORT_CELL_PT)}:${Math.floor(renderY / LOUPE_VIEWPORT_CELL_PT)}:${Math.max(1, Math.floor(magnification))}`;
}

/** One adjacent cell of overscan keeps continuous strokes visible while JS catches up. */
export function loupeViewportRenderBounds(key: string): HoldViewportBounds {
  'worklet';
  const [column, row, magnification] = key.split(':').map(Number);
  const extent = LOUPE_SIZE_PT / 2 / magnification + LOUPE_VIEWPORT_HALO_PT + LOUPE_VIEWPORT_CELL_PT;
  return {
    minX: column * LOUPE_VIEWPORT_CELL_PT - extent,
    minY: row * LOUPE_VIEWPORT_CELL_PT - extent,
    maxX: (column + 1) * LOUPE_VIEWPORT_CELL_PT + extent,
    maxY: (row + 1) * LOUPE_VIEWPORT_CELL_PT + extent,
  };
}

export function loupeViewportBounds(
  key: string,
  boardWidth: number,
  boardHeight: number,
  renderWidth: number,
  renderHeight: number,
): HoldViewportBounds {
  const bounds = loupeViewportRenderBounds(key);
  const boardScaleX = boardWidth / renderWidth;
  const boardScaleY = boardHeight / renderHeight;
  return {
    minX: bounds.minX * boardScaleX,
    minY: bounds.minY * boardScaleY,
    maxX: bounds.maxX * boardScaleX,
    maxY: bounds.maxY * boardScaleY,
  };
}

/** Live coverage, rather than a JS acknowledgement flag, also handles A → B → A. */
export function loupeViewportCovered(
  bounds: HoldViewportBounds | null,
  renderX: number,
  renderY: number,
  magnification: number,
): boolean {
  'worklet';
  if (!bounds) return false;
  const extent = LOUPE_SIZE_PT / 2 / Math.max(1, magnification) + LOUPE_VIEWPORT_HALO_PT;
  return (
    renderX - extent >= bounds.minX &&
    renderX + extent <= bounds.maxX &&
    renderY - extent >= bounds.minY &&
    renderY + extent <= bounds.maxY
  );
}

function currentViewportKey(viewport: SprayLoupeViewport): string {
  'worklet';
  return loupeViewportKey(viewport.centerXSV.value, viewport.centerYSV.value, viewport.magnificationSV.value);
}

function publishLoupeViewport(coverageSV: SharedValue<HoldViewportBounds | null>, key: string) {
  'worklet';
  coverageSV.value = loupeViewportRenderBounds(key);
}

/**
 * A cold loupe only mounts nearby rings. UI coverage controls visibility even
 * if JS is backlogged: adjacent cells remain covered by overscan, a distant
 * jump hides incomplete artwork, and returning to mounted geometry restores
 * it immediately without waiting for another React render.
 */
export function useSprayLoupeVisibleHolds(
  holds: readonly SprayEditorHold[],
  boardWidth: number,
  boardHeight: number,
): readonly SprayEditorHold[] {
  const viewport = useContext(SprayLoupeViewportContext);
  const [committedKey, setCommittedKey] = useState<string | null>(null);
  const coverageSV = useSharedValue<HoldViewportBounds | null>(null);
  const receiveViewport = useCallback(
    (key: string) => {
      if (viewport && currentViewportKey(viewport) === key) setCommittedKey(key);
    },
    [viewport],
  );

  useAnimatedReaction(
    () =>
      viewport
        ? {
            key: currentViewportKey(viewport),
            covered: loupeViewportCovered(
              coverageSV.value,
              viewport.centerXSV.value,
              viewport.centerYSV.value,
              viewport.magnificationSV.value,
            ),
          }
        : null,
    (current, previous) => {
      if (!viewport || current === null) return;
      if (viewport.readySV.value !== current.covered) viewport.readySV.value = current.covered;
      if (current.key !== previous?.key) runOnJS(receiveViewport)(current.key);
    },
    [viewport, coverageSV, receiveViewport],
  );

  const index = useMemo(
    () => (viewport ? buildSprayHoldViewportIndex(holds, boardWidth, boardHeight) : null),
    [viewport, holds, boardWidth, boardHeight],
  );
  const visible = useMemo(() => {
    if (!viewport) return holds;
    if (!index || committedKey === null) return NO_VISIBLE_HOLDS;
    return holdsInSprayViewport(
      index,
      loupeViewportBounds(committedKey, boardWidth, boardHeight, viewport.renderWidth, viewport.renderHeight),
    );
  }, [viewport, index, committedKey, holds, boardWidth, boardHeight]);

  useLayoutEffect(() => {
    if (!viewport) return;
    if (committedKey === null) setCommittedKey(currentViewportKey(viewport));
    else runOnUI(publishLoupeViewport)(coverageSV, committedKey);
  }, [viewport, committedKey, visible, coverageSV]);
  useLayoutEffect(
    () => () => {
      coverageSV.value = null;
      if (viewport) viewport.readySV.value = false;
    },
    [viewport, coverageSV],
  );

  return visible;
}
