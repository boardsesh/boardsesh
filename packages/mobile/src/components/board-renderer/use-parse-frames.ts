import { useMemo } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import { convertLitUpHoldsStringToMap, HOLD_STATE_MAP } from '@boardsesh/board-constants/hold-states';
import type { BoardHold, HoldPlacement } from './types';
import {
  getEffectiveHoldStateColor,
  getEffectiveHoldStateShape,
  useHoldColorOverrides,
} from '../../lib/hold-color-overrides';

/**
 * Parses a climb's `frames` string into an array of BoardHold objects ready for rendering.
 *
 * The frames string format is a comma-separated list of frames (usually just one).
 * Each frame contains entries like `p{holdId}r{stateCode}` — parsed by
 * `convertLitUpHoldsStringToMap` from board-constants.
 *
 * This hook resolves each hold ID to its (cx, cy, r) position from `holdsData`,
 * and maps the state code to a display color via HOLD_STATE_MAP.
 *
 * When `mirrored` is true, each hold with a `mirroredHoldId` is rendered at the
 * mirrored hold's (cx, cy) position instead — matching the web renderer's approach
 * of swapping individual hold positions rather than flipping the entire image.
 */
export function useParseFrames(
  frames: string,
  boardName: BoardName,
  holdsData: HoldPlacement[],
  mirrored: boolean = false,
): BoardHold[] {
  const {
    overrides: holdColorOverrides,
    shapes: holdShapeOverrides,
    brushThickness,
    shapeSize,
  } = useHoldColorOverrides();

  return useMemo(() => {
    if (!frames) return [];

    // Build a lookup from hold ID to its placement data
    const holdLookup = new Map<number, HoldPlacement>();
    for (const hold of holdsData) {
      holdLookup.set(hold.id, hold);
    }

    // Parse the frames string into a map of frameIndex -> { holdId -> { state, color, displayColor } }
    const frameMap = convertLitUpHoldsStringToMap(frames, boardName);

    // We render all frames overlaid (typically there is only one frame per climb).
    // Collect active holds from every frame.
    const result: BoardHold[] = [];
    const boardStateMap = HOLD_STATE_MAP[boardName];

    // Build a name -> renderStyle lookup map once to avoid O(n*m) inner loop
    const renderStyleByName = new Map<string, 'circle' | 'above-marker'>();
    if (boardStateMap) {
      for (const stateInfo of Object.values(boardStateMap)) {
        if (stateInfo.renderStyle) {
          renderStyleByName.set(stateInfo.name, stateInfo.renderStyle);
        }
      }
    }

    for (const litUpHoldsMap of Object.values(frameMap)) {
      for (const [holdIdStr, holdInfo] of Object.entries(litUpHoldsMap)) {
        const holdId = Number(holdIdStr);
        const placement = holdLookup.get(holdId);
        if (!placement) continue;

        // When mirrored, use the mirrored hold's position coordinates
        // instead of flipping the entire image (which would render text/logos backwards).
        let renderCx = placement.cx;
        let renderCy = placement.cy;
        let renderRadius = placement.r;

        if (mirrored && placement.mirroredHoldId) {
          const mirroredPlacement = holdLookup.get(placement.mirroredHoldId);
          if (mirroredPlacement) {
            renderCx = mirroredPlacement.cx;
            renderCy = mirroredPlacement.cy;
            renderRadius = mirroredPlacement.r;
          }
        }

        const renderStyle = renderStyleByName.get(holdInfo.state) ?? 'circle';

        result.push({
          id: holdId,
          cx: renderCx,
          cy: renderCy,
          radius: renderRadius,
          color: getEffectiveHoldStateColor(holdInfo.state, holdInfo.displayColor, holdColorOverrides),
          role: holdInfo.state,
          renderStyle,
          shape: getEffectiveHoldStateShape(holdInfo.state, holdShapeOverrides),
          brushThickness,
          shapeSize,
        });
      }
    }

    return result;
  }, [frames, boardName, holdsData, mirrored, holdColorOverrides, holdShapeOverrides, brushThickness, shapeSize]);
}
