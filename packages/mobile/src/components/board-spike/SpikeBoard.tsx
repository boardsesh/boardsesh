import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { convertLitUpHoldsStringToMap } from '@boardsesh/board-constants/hold-states';
import { backgroundImageUri } from '../LayeredClimbImage';
import { getBoardRenderData } from '../../lib/board-details';
import { ensureBackgroundsCached, tryGetBackgroundPathsSync } from '../../lib/background-image-cache';
import { SpikeBoardOverlay } from './SpikeBoardOverlay';
import { SPIKE_HOLD_OUTLINES } from './spike-hold-outlines';
import { boardWantsNeutralHalos, synthesiseSpikeFrames, type SpikeBoardConfig } from './spike-boards';
import type { HaloScope, SpikeLitHold, SpikeOverride, SpikePaletteKey, SpikeTreatment } from './spike-config';

type SpikeBoardProps = {
  board: SpikeBoardConfig;
  treatment: SpikeTreatment;
  backgroundColor: string;
  /** Curve the traced outlines instead of joining their points straight. */
  smooth: boolean;
  palette: SpikePaletteKey;
  /** Force the every-hold neutral outline on or off, or leave it to the board. */
  halosOverride: SpikeOverride;
  /**
   * Draw the LED layer. Its own axis, on in every arm the capture script shoots,
   * so the arms differ by their treatment and not by whether the board's LEDs
   * have been taken over.
   */
  leds: boolean;
};

/**
 * Whether this board, under this treatment, draws the neutral outline on unlit
 * holds. The override wins outright; left on `auto`, a treatment with
 * `haloPolicy: 'never'` keeps the scope it was defined with and everything else
 * defers to the board's measured share of low-contrast holds.
 *
 * The override has to be read FIRST. Reading the policy first made the chip
 * one-way — it could subtract the casing from a treatment that carried one and
 * could never add it to a treatment defined without one — and since the casing
 * became its own chip none of the captured arms carries one, so the control was
 * inert on every panel it was there to vary.
 */
function resolveHalos(treatment: SpikeTreatment, board: SpikeBoardConfig, override: SpikeOverride): HaloScope {
  if (override === 'on') return treatment.halos === 'near' ? 'near' : 'all';
  if (override === 'off') return 'none';
  if ((treatment.haloPolicy ?? 'never') === 'never') return treatment.halos;
  if (treatment.halos === 'near') return 'near';
  return boardWantsNeutralHalos(board) ? 'all' : 'none';
}

/**
 * The spike's board surface: a solid play field, the board art over it, and one
 * overlay treatment on top.
 *
 * The art goes through `expo-image` on the same bundled `file://` paths the
 * shipping stack resolves, so the spike adds no assets, no network and no
 * per-board preprocessing; react-native-svg is the overlay only. Contrast
 * variants of the art, if they are ever wanted, belong in
 * `scripts/generate-dark-board-art.ts` as a second committed suffix — that
 * pipeline already has a `--check` mode and a golden test, and
 * `background-image-cache.ts` already prefers a sibling when one is bundled.
 *
 * Deliberately does NOT go through BoardImageNative / the Rust renderer: the
 * point is to try overlays the renderer cannot draw yet.
 */
export function SpikeBoard({
  board,
  treatment,
  backgroundColor,
  smooth,
  palette,
  halosOverride,
  leds,
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
    // Only light placements that actually carry a hold. A real climb can never
    // reference a placement with no hold in the selected sets, so neither should
    // the synthesised one.
    const eligible = new Set(Object.keys(SPIKE_HOLD_OUTLINES[board.key] ?? {}).map(Number));
    return synthesiseSpikeFrames(
      board.boardName,
      renderData.holdsData,
      renderData.boardWidth,
      renderData.boardHeight,
      eligible.size > 0 ? eligible : undefined,
    );
  }, [board.boardName, board.key, renderData]);

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

  if (!renderData) return <View style={[styles.board, { backgroundColor }]} />;

  const { boardWidth, boardHeight } = renderData;

  return (
    <View style={[styles.board, { backgroundColor, aspectRatio: boardWidth / boardHeight }]}>
      {artPaths.map((path) => (
        <Image
          key={path}
          // The same helper the shipping stack uses: a bare `file://` prefix
          // blanks the board in the browser build, where the path is an http URL.
          source={{ uri: backgroundImageUri(path) }}
          style={styles.layer}
          contentFit="contain"
          cachePolicy="memory-disk"
          // The layers are native-resolution art drawn into a full-width board,
          // so there is nothing to downscale — skip expo-image's main-thread
          // resample, same as LayeredClimbImage.
          allowDownscaling={false}
        />
      ))}
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
        leds={leds}
        veil={treatment.veil ?? false}
        // The veil is a wash of the field, so it has to be the field the board is
        // actually sitting on — including the grey and plywood chips, where the
        // whole point is that the wall it is quieting is a different colour.
        playFieldColor={backgroundColor}
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
