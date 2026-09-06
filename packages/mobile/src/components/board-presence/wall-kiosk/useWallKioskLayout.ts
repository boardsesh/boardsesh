import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dimensions, Platform, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  quantizeDimension,
  resolveWallKioskLayout,
  type WallKioskInsets,
  type WallKioskLayout,
} from './wall-kiosk-layout';
import {
  bandContentFloor,
  estimatePhysicalLongSideMm,
  fitGradeToChrome,
  resolveHeroScale,
  resolveWallKioskTypeScale,
  type WallKioskTypeScale,
} from './wall-kiosk-type';

const SETTLE_DELAY_MS = 250;

type Pane = { width: number; height: number };

export type WallKioskLayoutState = {
  /** Attach to the kiosk root View to measure its own content pane. */
  onLayout: (event: LayoutChangeEvent) => void;
  /** Null until the pane is measured / for a zero board AR. */
  layout: WallKioskLayout | null;
  /** Hero type scale, with the grade already fitted to the resolved chrome extent. */
  typeScale: WallKioskTypeScale;
  pane: Pane | null;
};

/**
 * React wrapper around the pure {@link resolveWallKioskLayout}. Measures the tab's
 * OWN pane (sidebar already excluded), subtracts safe-area insets, and FREEZES the
 * last stable layout during an in-flight resize/rotation (commit only after the
 * `onLayout` burst settles for {@link SETTLE_DELAY_MS}) — the fix for the rotation
 * region-flip teleport. Computes the type scale FIRST so the chrome band is sized
 * to fund the climb name + controls, then fits the grade back down to the resolved
 * chrome extent.
 */
export function useWallKioskLayout(boardAspectRatio: number | null): WallKioskLayoutState {
  const rawInsets = useSafeAreaInsets();
  const insets: WallKioskInsets = useMemo(
    () => ({ top: rawInsets.top, bottom: rawInsets.bottom, left: rawInsets.left, right: rawInsets.right }),
    [rawInsets.top, rawInsets.bottom, rawInsets.left, rawInsets.right],
  );

  const [pane, setPane] = useState<Pane | null>(null);
  const settledOnceRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevRegionRef = useRef<Pick<WallKioskLayout, 'region'> | null>(null);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width <= 0 || height <= 0) return;
    if (!settledOnceRef.current) {
      settledOnceRef.current = true;
      setPane({ width, height });
      return;
    }
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      setPane((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    }, SETTLE_DELAY_MS);
  }, []);

  useEffect(
    () => () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    },
    [],
  );

  const resolved = useMemo(() => {
    const shortSide = pane ? Math.min(pane.width, pane.height) : 0;
    const screen = Dimensions.get('screen');
    // The physical-size estimate assumes iPad points-per-inch. On Android
    // `Dimensions` returns density-bucketed dp with no reliable ppi, so pass null and
    // let resolveHeroScale fall back to the pane short side (the external-display /
    // unknown-model path) rather than compute a wrong physical size.
    const physicalLongSideMm =
      Platform.OS === 'ios' ? estimatePhysicalLongSideMm(Math.max(screen.width, screen.height)) : null;
    const heroScale = resolveHeroScale({ physicalLongSideMm, paneShortSide: shortSide });
    const baseType = resolveWallKioskTypeScale(shortSide, heroScale);

    if (!pane || !boardAspectRatio || boardAspectRatio <= 0) {
      return { layout: null as WallKioskLayout | null, typeScale: baseType };
    }
    const contentWidth = quantizeDimension(pane.width - insets.left - insets.right);
    const layout = resolveWallKioskLayout({
      paneW: pane.width,
      paneH: pane.height,
      insets,
      boardAspectRatio,
      heroScale,
      contentFloorBand: bandContentFloor(baseType, contentWidth),
      previous: prevRegionRef.current,
    });
    if (!layout) return { layout: null, typeScale: baseType };
    const chromeExtent = layout.region === 'rail' ? layout.chromeRect.width : layout.chromeRect.height;
    return { layout, typeScale: fitGradeToChrome(baseType, layout.region, chromeExtent) };
  }, [pane, insets, boardAspectRatio]);

  useEffect(() => {
    // Keep the last resolved region across a transient null (e.g. a board switch
    // briefly nulls the aspect ratio) so region hysteresis isn't lost across it.
    if (resolved.layout) prevRegionRef.current = { region: resolved.layout.region };
  }, [resolved.layout]);

  return { onLayout, layout: resolved.layout, typeScale: resolved.typeScale, pane };
}
