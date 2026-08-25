import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { convertLitUpHoldsStringToMap } from '@boardsesh/board-constants/hold-states';
import { getBoardRenderData } from '../../lib/board-details';
import { SPIKE_BOARD_ART, type SpikeArtLevel } from './spike-art';
import { SpikeBoardOverlay } from './SpikeBoardOverlay';
import {
  SPIKE_BOARD,
  SPIKE_FRAMES,
  type SpikeLitHold,
  type SpikePaletteKey,
  type SpikeTreatment,
} from './spike-config';

type SpikeBoardProps = {
  treatment: SpikeTreatment;
  art: SpikeArtLevel;
  backgroundColor: string;
  palette: SpikePaletteKey;
};

/**
 * The spike's board surface: a solid play field, the board-art layers stacked on
 * top of it, and one SVG treatment over that. Deliberately does NOT go through
 * BoardImageNative / the Rust renderer — the whole point is to try overlays the
 * renderer cannot draw yet, so they live in SVG until one is worth porting.
 */
export function SpikeBoard({ treatment, art, backgroundColor, palette }: SpikeBoardProps) {
  const renderData = useMemo(
    () =>
      getBoardRenderData({
        boardName: SPIKE_BOARD.boardName,
        layoutId: SPIKE_BOARD.layoutId,
        sizeId: SPIKE_BOARD.sizeId,
        setIds: [...SPIKE_BOARD.setIds],
      }),
    [],
  );

  const litHolds = useMemo<SpikeLitHold[]>(() => {
    if (!renderData) return [];
    const placementById = new Map(renderData.holdsData.map((placement) => [placement.id, placement]));
    const holds: SpikeLitHold[] = [];
    for (const frame of Object.values(convertLitUpHoldsStringToMap(SPIKE_FRAMES, SPIKE_BOARD.boardName))) {
      for (const [holdId, info] of Object.entries(frame)) {
        const placement = placementById.get(Number(holdId));
        if (!placement) continue;
        holds.push({ id: placement.id, cx: placement.cx, cy: placement.cy, radius: placement.r, role: info.state });
      }
    }
    return holds;
  }, [renderData]);

  if (!renderData) return <View style={[styles.board, { backgroundColor }]} />;

  return (
    <View style={[styles.board, { backgroundColor, aspectRatio: renderData.boardWidth / renderData.boardHeight }]}>
      {SPIKE_BOARD_ART[art].map((source, layerIndex) => (
        // Index keys are fine: the layer list for a board config is fixed and
        // ordered, and these have no state.
        // eslint-disable-next-line react/no-array-index-key
        <Image
          key={`${art}-${layerIndex}`}
          source={source}
          style={styles.layer}
          contentFit="contain"
          cachePolicy="memory-disk"
          allowDownscaling={false}
        />
      ))}
      <SpikeBoardOverlay
        boardWidth={renderData.boardWidth}
        boardHeight={renderData.boardHeight}
        placements={renderData.holdsData}
        litHolds={litHolds}
        halos={treatment.halos}
        selector={treatment.selector}
        palette={palette}
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
