import { memo, useId, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Defs, Mask, Path, Rect } from 'react-native-svg';
import { overlays } from '../../theme/tokens';
import type { SprayEditorHold } from './spray-hold-editor-reducer';
import { holdsOnlyPreviewPath, type RefinedHoldPreview } from './spray-holds-only-preview';

type SprayHoldsOnlyPreviewProps = {
  holds: readonly SprayEditorHold[];
  refined?: RefinedHoldPreview | null;
  boardWidth: number;
  boardHeight: number;
  renderWidth: number;
  renderHeight: number;
};

/**
 * Hide the wall around ON holds, over the existing photo and inside its zoom
 * transform. No second image, saved art, or registry write: the holes reveal
 * exactly the local photo the editor already displays, including its zoom.
 * One path keeps the native node count constant on a densely set wall.
 */
export const SprayHoldsOnlyPreview = memo(function SprayHoldsOnlyPreview({
  holds,
  refined,
  boardWidth,
  boardHeight,
  renderWidth,
  renderHeight,
}: SprayHoldsOnlyPreviewProps) {
  const maskId = `spray-holds-only-${useId().replace(/:/g, '')}`;
  const path = useMemo(() => holdsOnlyPreviewPath(holds, refined), [holds, refined]);
  if (boardWidth <= 0 || boardHeight <= 0 || renderWidth <= 0 || renderHeight <= 0) return null;

  return (
    <Svg
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      width={renderWidth}
      height={renderHeight}
      viewBox={`0 0 ${boardWidth} ${boardHeight}`}
      testID="spray-holds-only-preview"
    >
      <Defs>
        <Mask
          id={maskId}
          x={0}
          y={0}
          width={boardWidth}
          height={boardHeight}
          maskUnits="userSpaceOnUse"
          maskContentUnits="userSpaceOnUse"
          maskType="luminance"
        >
          <Rect width={boardWidth} height={boardHeight} fill={overlays.onScrim} />
          <Path d={path} fill={overlays.loupeBackdrop} fillRule="nonzero" />
        </Mask>
      </Defs>
      <Rect width={boardWidth} height={boardHeight} fill={overlays.loupeBackdrop} mask={`url(#${maskId})`} />
    </Svg>
  );
});
