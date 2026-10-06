import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { G, Path } from 'react-native-svg';
import type { LostHoldGhost } from '@boardsesh/create-climb-react';
import type { BoardName } from '@boardsesh/shared-schema';
import { useHoldColorOverrides } from '../../lib/hold-color-overrides';
import { placementRingPathData, radiusRingToBoardPx, ringToPathData } from '../outline-editor/stroke';
import { brushRoleColor, PAINT_ROLES, type BrushRole } from './brush-roles';
import type { HighlightedHold } from './use-lost-hold-ghosts';

/**
 * Line weights in SCREEN points at 1x zoom. Converted to photo pixels below so
 * a ring reads the same on a 1,000 px photo and a 4,096 px one.
 *
 * A ghost is dashed in its old role's colour over a dark halo: the photo behind
 * it is multicoloured plastic, and the dash pattern — not the hue — is what says
 * "this hold is not here any more". A highlighted replacement is a solid white
 * ring; the reset review's successor gets a heavier one.
 */
const GHOST_WIDTH_PT = 2.5;
const HALO_EXTRA_PT = 2;
const GHOST_DASH_PT = [6, 4] as const;
const CANDIDATE_WIDTH_PT = 2;
const SUCCESSOR_WIDTH_PT = 3.5;
const HALO_COLOR = 'rgba(0,0,0,0.6)';
const CANDIDATE_COLOR = '#FFFFFF';

type Ring = { id: number; cx: number; cy: number; r: number; outline?: readonly number[] | null };

function ringPath(ring: Ring): string {
  const circle = { id: ring.id, cx: ring.cx, cy: ring.cy, r: ring.r };
  return ring.outline ? ringToPathData(radiusRingToBoardPx([...ring.outline], circle)) : placementRingPathData(circle);
}

function isPaintRole(role: string): role is Exclude<BrushRole, 'OFF'> {
  return (PAINT_ROLES as readonly string[]).includes(role);
}

type LostHoldGhostLayerProps = {
  boardName: BoardName;
  /** Ghosts still unanswered, in the wall photo's pixels. */
  ghosts: readonly LostHoldGhost[];
  /** Live holds offered as replacements right now; empty outside a pick. */
  candidateHolds: readonly HighlightedHold[];
  boardWidth: number;
  boardHeight: number;
  renderWidth: number;
  renderHeight: number;
};

/**
 * Dashed rings where a climb's lost holds used to be (#5493), drawn into
 * `InteractiveCreateBoard`'s `overlay` slot — inside the zoom transform, so the
 * rings pan and zoom with the photo, and under the painted holds.
 *
 * Coordinates are photo pixels: the lost holds went through the same inverse
 * homography as the live ones (`mapCanonicalHoldsToPhoto`), and the `viewBox`
 * maps photo pixels onto the rendered board exactly the way the hold targets do.
 * Purely visual: taps reach the ghosts through the board's own hit targets.
 */
export const LostHoldGhostLayer = React.memo(function LostHoldGhostLayer({
  boardName,
  ghosts,
  candidateHolds,
  boardWidth,
  boardHeight,
  renderWidth,
  renderHeight,
}: LostHoldGhostLayerProps) {
  // Photo pixels per screen point at 1x.
  const pxPerPt = renderWidth > 0 ? boardWidth / renderWidth : 1;

  // The climber's own role colours, so a ghost matches the paint it stands for.
  const { overrides: holdColorOverrides } = useHoldColorOverrides();
  const ghostRings = useMemo(
    () =>
      ghosts.map((ghost) => ({
        id: ghost.id,
        color: isPaintRole(ghost.role) ? brushRoleColor(boardName, ghost.role, holdColorOverrides) : ghost.color,
        path: ringPath(ghost),
      })),
    [ghosts, boardName, holdColorOverrides],
  );
  const candidateRings = useMemo(
    () => candidateHolds.map((hold) => ({ id: hold.id, isSuccessor: hold.isSuccessor, path: ringPath(hold) })),
    [candidateHolds],
  );

  if (ghostRings.length === 0 && candidateRings.length === 0) return null;

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
      {candidateRings.map((ring) => {
        const width = (ring.isSuccessor ? SUCCESSOR_WIDTH_PT : CANDIDATE_WIDTH_PT) * pxPerPt;
        return (
          <G key={`candidate-${ring.id}`} testID={`lost-hold-candidate-${ring.id}`}>
            <Path d={ring.path} fill="none" stroke={HALO_COLOR} strokeWidth={width + HALO_EXTRA_PT * pxPerPt} />
            <Path d={ring.path} fill="none" stroke={CANDIDATE_COLOR} strokeWidth={width} />
          </G>
        );
      })}
      {ghostRings.map((ring) => (
        <G key={`ghost-${ring.id}`} testID={`lost-hold-ghost-${ring.id}`}>
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
            stroke={ring.color}
            strokeWidth={GHOST_WIDTH_PT * pxPerPt}
            strokeDasharray={dash}
          />
        </G>
      ))}
    </Svg>
  );
});
