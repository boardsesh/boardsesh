import React, { useMemo } from 'react';
import { View, type ViewStyle } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { getQuantumNeutralGrid } from '@boardsesh/board-config';
import { useTheme } from '../../providers/theme-provider';
import { getQuantumGeometryBoardDetails, useQuantumGeometry } from '../../lib/quantum-geometry-store';
import { BoardHoldOverlay } from '../board-renderer/BoardHoldOverlay';
import { useParseFrames } from '../board-renderer/use-parse-frames';
import type { HoldPlacement } from '../board-renderer/types';
import { getQuantumNeutralGridPath, getQuantumRenderPathData } from './quantum-board-paths';

const EMPTY_HOLDS: HoldPlacement[] = [];

type QuantumBoardImageProps = {
  frames: string;
  layoutId: number;
  sizeId: number;
  style?: ViewStyle;
  overlayTestID?: string;
};

/**
 * A deliberately neutral Quantum wall: exact advertised model grid plus hold
 * centres projected from the signed catalogue geometry. It contains no copied
 * manufacturer artwork, logo, or guessed row-major placement identity.
 */
export const QuantumBoardImage = React.memo(function QuantumBoardImage({
  frames,
  layoutId,
  sizeId,
  style,
  overlayTestID,
}: QuantumBoardImageProps) {
  const { chartColors } = useTheme();
  const geometry = useQuantumGeometry(layoutId, sizeId);
  const neutralGrid = useMemo(() => getQuantumNeutralGrid(layoutId, sizeId), [layoutId, sizeId]);
  const boardDetails = useMemo(
    () => (geometry ? getQuantumGeometryBoardDetails(layoutId, sizeId) : null),
    [geometry, layoutId, sizeId],
  );
  const renderPathData = boardDetails ? getQuantumRenderPathData(boardDetails) : null;
  const holdsData = renderPathData?.holdsData ?? EMPTY_HOLDS;
  // Quantum models do not advertise mirroring. Keeping this false also avoids
  // visually plausible but controller-wrong hold swaps on a crafted route.
  const litHolds = useParseFrames(frames, 'quantum', holdsData, false);

  if (!neutralGrid) {
    // Unknown layout/size pairs render nothing. The caller retains its measured
    // container, but we do not invent a model shape for invalid configuration.
    return <View style={style} />;
  }

  const { boardWidth, boardHeight } = neutralGrid;
  const neutralGridPath = getQuantumNeutralGridPath(neutralGrid);
  const containerStyle: ViewStyle = {
    width: '100%',
    aspectRatio: boardWidth / boardHeight,
    backgroundColor: chartColors.secondaryBackground,
    ...style,
  };

  return (
    <View style={containerStyle}>
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${boardWidth} ${boardHeight}`}
        preserveAspectRatio="xMidYMid meet"
        testID={litHolds.length > 0 ? overlayTestID : undefined}
      >
        <Rect width={boardWidth} height={boardHeight} fill={chartColors.secondaryBackground} />
        <Path testID="quantum-neutral-grid" d={neutralGridPath} stroke={chartColors.separator} strokeWidth={2} />
        {renderPathData?.neutralHoldsPath ? (
          <Path
            testID="quantum-neutral-holds"
            d={renderPathData.neutralHoldsPath}
            fill={chartColors.secondaryLabel}
            fillOpacity={0.34}
          />
        ) : null}
        <BoardHoldOverlay holds={litHolds} />
      </Svg>
    </View>
  );
});
