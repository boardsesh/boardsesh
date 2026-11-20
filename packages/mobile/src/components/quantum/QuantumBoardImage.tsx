import React, { useLayoutEffect, useMemo, type ReactNode } from 'react';
import type { BoardArtReadiness } from '../../lib/board-render/ready-board-art';
import { useBoardAccessibilitySummary } from '../../hooks/use-board-accessibility-summary';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { getQuantumNeutralGrid } from '@boardsesh/board-config';
import { useTheme } from '../../providers/theme-provider';
import { getQuantumGeometryBoardDetails, useQuantumGeometry } from '../../lib/quantum-geometry-store';
import { BoardHoldOverlay } from '../board-renderer/BoardHoldOverlay';
import { useParseFrames } from '../board-renderer/use-parse-frames';
import type { HoldPlacement } from '../board-renderer/types';
import { getQuantumNeutralGridPath, getQuantumRenderPathData } from './quantum-board-paths';
import type { HoldColorOverrides } from '../../lib/hold-color-overrides';

const EMPTY_HOLDS: HoldPlacement[] = [];

type QuantumBoardImageProps = {
  frames: string;
  layoutId: number;
  sizeId: number;
  style?: ViewStyle;
  overlayTestID?: string;
  onArtReadinessChange?: (readiness: BoardArtReadiness) => void;
  onArtDisplayed?: () => void;
  accessible?: boolean;
  underOverlay?: ReactNode;
  holdColorOverride?: HoldColorOverrides;
};

/**
 * A neutral Quantum wall: hold centres projected from the fixed bundled
 * geometry, with source-coordinate aspect independent of protocol grid metadata. It contains no copied
 * manufacturer artwork, logo, or guessed row-major placement identity.
 */
export const QuantumBoardImage = React.memo(function QuantumBoardImage({
  frames,
  layoutId,
  sizeId,
  style,
  overlayTestID,
  onArtReadinessChange,
  onArtDisplayed,
  accessible = true,
  underOverlay,
  holdColorOverride,
}: QuantumBoardImageProps) {
  const { chartColors } = useTheme();
  const accessibilitySummary = useBoardAccessibilitySummary('quantum', frames);
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
  const litHolds = useParseFrames(frames, 'quantum', holdsData, false, holdColorOverride);

  useLayoutEffect(() => {
    const readiness = !neutralGrid ? 'failed' : !geometry ? 'loading' : 'ready';
    onArtReadinessChange?.(readiness);
    if (readiness === 'ready') onArtDisplayed?.();
  }, [frames, geometry, neutralGrid, onArtReadinessChange, onArtDisplayed]);

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
    <View
      style={containerStyle}
      accessible={accessible}
      accessibilityRole={accessible ? 'image' : undefined}
      accessibilityLabel={accessible ? accessibilitySummary : undefined}
    >
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${boardWidth} ${boardHeight}`}
        preserveAspectRatio="xMidYMid meet"
        pointerEvents="none"
        testID={!underOverlay && litHolds.length > 0 ? overlayTestID : undefined}
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
        {!underOverlay ? <BoardHoldOverlay holds={litHolds} /> : null}
      </Svg>
      {underOverlay}
      {underOverlay ? (
        <Svg
          width="100%"
          height="100%"
          viewBox={`0 0 ${boardWidth} ${boardHeight}`}
          preserveAspectRatio="xMidYMid meet"
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
          testID={litHolds.length > 0 ? overlayTestID : undefined}
        >
          <BoardHoldOverlay holds={litHolds} />
        </Svg>
      ) : null}
    </View>
  );
});
