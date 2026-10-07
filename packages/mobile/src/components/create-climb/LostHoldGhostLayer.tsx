import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import { placementRingPathData, radiusRingToBoardPx, ringToPathData } from '../outline-editor/stroke';
import type { LostHoldGhost } from './use-lost-hold-ghosts';

/**
 * Line weights in SCREEN points at 1x zoom, converted to photo pixels below so
 * a ring reads the same on a 1,000 px photo and a 4,096 px one.
 *
 * Grey and dashed over a dark halo: the photo behind it is multicoloured
 * plastic, so neither a role colour nor a solid line would say "this hold is not
 * here any more". Grey is no role's colour, so it never reads as part of the
 * climb.
 */
const GHOST_WIDTH_PT = 2.5;
const HALO_EXTRA_PT = 2;
const GHOST_DASH_PT = [6, 4] as const;
const HALO_COLOR = 'rgba(0,0,0,0.6)';
const GHOST_COLOR = '#A1A1AA';

function ringPath(ghost: LostHoldGhost): string {
  const circle = { id: ghost.id, cx: ghost.cx, cy: ghost.cy, r: ghost.r };
  return ghost.outline
    ? ringToPathData(radiusRingToBoardPx([...ghost.outline], circle))
    : placementRingPathData(circle);
}

type LostHoldGhostLayerProps = {
  /** Rings still on the board, in the wall photo's pixels. */
  ghosts: readonly LostHoldGhost[];
  boardWidth: number;
  boardHeight: number;
  renderWidth: number;
  renderHeight: number;
};

/**
 * Grey dashed rings where a remixed climb's lost holds used to be, drawn into
 * `InteractiveCreateBoard`'s `overlay` slot: inside the zoom transform, so the
 * rings pan and zoom with the photo.
 *
 * Coordinates are photo pixels: the lost holds went through the same inverse
 * homography as the live ones (`mapCanonicalHoldsToPhoto`), and the `viewBox`
 * maps photo pixels onto the rendered board exactly the way the hold targets do.
 * Purely visual: taps reach the rings through the board's own hit targets.
 */
export const LostHoldGhostLayer = React.memo(function LostHoldGhostLayer({
  ghosts,
  boardWidth,
  boardHeight,
  renderWidth,
  renderHeight,
}: LostHoldGhostLayerProps) {
  // Photo pixels per screen point at 1x.
  const pxPerPt = renderWidth > 0 ? boardWidth / renderWidth : 1;
  const rings = useMemo(() => ghosts.map((ghost) => ({ id: ghost.id, path: ringPath(ghost) })), [ghosts]);
  if (rings.length === 0) return null;

  const dash = GHOST_DASH_PT.map((length) => length * pxPerPt);
  return (
    <Svg
      style={StyleSheet.absoluteFill}
      width={renderWidth}
      height={renderHeight}
      viewBox={`0 0 ${boardWidth} ${boardHeight}`}
      preserveAspectRatio="none"
      pointerEvents="none"
      testID="lost-hold-ghost-layer"
    >
      {rings.map((ring) => (
        <G key={ring.id} testID={`lost-hold-ghost-${ring.id}`}>
          <Path
            d={ring.path}
            fill="none"
            stroke={HALO_COLOR}
            strokeWidth={(GHOST_WIDTH_PT + HALO_EXTRA_PT) * pxPerPt}
            strokeDasharray={dash}
          />
          <Path
            d={ring.path}
            fill="none"
            stroke={GHOST_COLOR}
            strokeWidth={GHOST_WIDTH_PT * pxPerPt}
            strokeDasharray={dash}
          />
        </G>
      ))}
    </Svg>
  );
});
