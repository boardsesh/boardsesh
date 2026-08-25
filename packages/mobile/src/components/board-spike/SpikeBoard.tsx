import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { ClipPath, Defs, FeColorMatrix, Filter, G, Image as SvgImage, Path } from 'react-native-svg';
import { convertLitUpHoldsStringToMap } from '@boardsesh/board-constants/hold-states';
import { getBoardRenderData } from '../../lib/board-details';
import { ensureBackgroundsCached, tryGetBackgroundPathsSync } from '../../lib/background-image-cache';
import { SPIKE_OKLAB_ART, type SpikeArtLevel } from './spike-art';
import { SpikeBoardOverlay } from './SpikeBoardOverlay';
import { SPIKE_HOLD_OUTLINES } from './spike-hold-outlines';
import { polygonPath, splinePath } from './spike-shapes';
import { boardWantsNeutralHalos, synthesiseSpikeFrames, type SpikeBoardConfig } from './spike-boards';
import type { HaloScope, SpikeLitHold, SpikeOverride, SpikePaletteKey, SpikeTreatment } from './spike-config';

type SpikeBoardProps = {
  board: SpikeBoardConfig;
  treatment: SpikeTreatment;
  art: SpikeArtLevel;
  backgroundColor: string;
  palette: SpikePaletteKey;
  /** Drain the colour out of the board art, leaving the lit holds as the only hue. */
  desaturate: boolean;
  /** Curve the traced outlines instead of joining their points straight. */
  smooth: boolean;
  /** Force the every-hold neutral outline on or off, or leave it to the board. */
  halosOverride: SpikeOverride;
};

/**
 * Whether this board, under this treatment, draws the neutral outline on unlit
 * holds. A treatment with `haloPolicy: 'never'` is defined without it and is
 * never given one; everything else defers to the board's measured share of
 * low-contrast holds unless the override says otherwise.
 */
function resolveHalos(treatment: SpikeTreatment, board: SpikeBoardConfig, override: SpikeOverride): HaloScope {
  if ((treatment.haloPolicy ?? 'never') === 'never') return treatment.halos;
  if (override === 'on') return treatment.halos === 'near' ? 'near' : 'all';
  if (override === 'off') return 'none';
  if (treatment.halos === 'near') return 'near';
  return boardWantsNeutralHalos(board) ? 'all' : 'none';
}

/**
 * The spike's board surface: a solid play field, the board-art layers over it,
 * and one overlay treatment on top.
 *
 * The art is drawn as SVG images rather than `expo-image` layers (which is what
 * the shipping renderer stack uses) for one reason: an SVG `<Filter>` can drain
 * the saturation out of them, and the lit holds can then be redrawn in full
 * colour through a clip of their own silhouettes. That is the "desaturate the
 * unselected holds" idea with no new assets and no per-board preprocessing —
 * bright blue set holds stop competing with lit ones, and the lit ones keep
 * their real colour.
 *
 * Deliberately does NOT go through BoardImageNative / the Rust renderer: the
 * point is to try overlays the renderer cannot draw yet.
 */
export function SpikeBoard({
  board,
  treatment,
  art,
  backgroundColor,
  palette,
  desaturate,
  smooth,
  halosOverride,
}: SpikeBoardProps) {
  const renderData = useMemo(
    () =>
      getBoardRenderData({
        boardName: board.boardName,
        layoutId: board.layoutId,
        sizeId: board.sizeId,
        setIds: [...board.setIds],
      }),
    [board],
  );

  const backgroundParams = useMemo(
    () => ({
      boardName: board.boardName,
      layoutId: board.layoutId,
      sizeId: board.sizeId,
      setIds: [...board.setIds],
      variant: 'full' as const,
      colorScheme: 'dark' as const,
    }),
    [board],
  );

  // Bundled assets resolve synchronously in release builds and need an async
  // materialisation pass under Metro, so do both — same contract as
  // useNativeClimbRender.
  const [artPaths, setArtPaths] = useState<string[]>(() => tryGetBackgroundPathsSync(backgroundParams)?.paths ?? []);
  useEffect(() => {
    let cancelled = false;
    setArtPaths(tryGetBackgroundPathsSync(backgroundParams)?.paths ?? []);
    void ensureBackgroundsCached(backgroundParams).then((result) => {
      if (!cancelled && result) setArtPaths(result.paths);
    });
    return () => {
      cancelled = true;
    };
  }, [backgroundParams]);

  const frames = useMemo(() => {
    if (!renderData) return '';
    return synthesiseSpikeFrames(board.boardName, renderData.holdsData, renderData.boardWidth, renderData.boardHeight);
  }, [board.boardName, renderData]);

  const litHolds = useMemo<SpikeLitHold[]>(() => {
    if (!renderData || frames === '') return [];
    const placementById = new Map(renderData.holdsData.map((placement) => [placement.id, placement]));
    const holds: SpikeLitHold[] = [];
    for (const frame of Object.values(convertLitUpHoldsStringToMap(frames, board.boardName))) {
      for (const [holdId, info] of Object.entries(frame)) {
        const placement = placementById.get(Number(holdId));
        if (!placement) continue;
        holds.push({ id: placement.id, cx: placement.cx, cy: placement.cy, radius: placement.r, role: info.state });
      }
    }
    return holds;
  }, [board.boardName, renderData, frames]);

  // The lit holds' silhouettes, as one clip region, so the full-colour art can
  // be punched back through the desaturated stack.
  const litClipPaths = useMemo(() => {
    if (!renderData) return [];
    const outlines = SPIKE_HOLD_OUTLINES[board.key] ?? {};
    return litHolds
      .map((hold) => {
        const points = outlines[hold.id];
        if (points === undefined || points.length < 6) return null;
        return smooth ? splinePath(points, hold.cx, hold.cy) : polygonPath(points, hold.cx, hold.cy);
      })
      .filter((path): path is string => path !== null);
  }, [board.key, litHolds, renderData, smooth]);

  // The OkLab-stretched art exists for one board only; every other board falls
  // back to its shipped art rather than silently rendering nothing.
  const oklabPaths = art === 'original' ? null : (SPIKE_OKLAB_ART[board.key]?.[art] ?? null);
  const sources = oklabPaths ?? artPaths.map((path) => ({ uri: `file://${path}` }));

  if (!renderData) return <View style={[styles.board, { backgroundColor }]} />;

  const { boardWidth, boardHeight } = renderData;
  const artLayers = sources.map((source, index) => (
    <SvgImage
      // Layer order is fixed for a board config and the layers have no state.
      // eslint-disable-next-line react/no-array-index-key
      key={`${board.key}-${art}-${index}`}
      href={source}
      x={0}
      y={0}
      width={boardWidth}
      height={boardHeight}
      preserveAspectRatio="none"
    />
  ));

  return (
    <View style={[styles.board, { backgroundColor, aspectRatio: boardWidth / boardHeight }]}>
      <Svg width="100%" height="100%" viewBox={`0 0 ${boardWidth} ${boardHeight}`} style={styles.layer}>
        <Defs>
          <Filter id="spike-desaturate">
            <FeColorMatrix type="saturate" values="0" />
          </Filter>
          <ClipPath id="spike-lit-holds">
            {litClipPaths.map((path) => (
              <Path key={path} d={path} />
            ))}
          </ClipPath>
        </Defs>
        <G filter={desaturate ? 'url(#spike-desaturate)' : undefined}>{artLayers}</G>
        {desaturate && litClipPaths.length > 0 && <G clipPath="url(#spike-lit-holds)">{artLayers}</G>}
      </Svg>
      <SpikeBoardOverlay
        boardKey={board.key}
        boardWidth={boardWidth}
        boardHeight={boardHeight}
        placements={renderData.holdsData}
        litHolds={litHolds}
        halos={resolveHalos(treatment, board, halosOverride)}
        haloShape={treatment.haloShape ?? 'circle'}
        selector={treatment.selector}
        palette={palette}
        smooth={smooth}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  board: {
    width: '100%',
  },
  layer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
});
