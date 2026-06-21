import React from 'react';
import { G, Polygon } from 'react-native-svg';
import { HoldMarkerShapeElement } from './HoldMarkerShape';
import type { BoardHold } from './types';

type BoardHoldOverlayProps = {
  holds: BoardHold[];
};

const FILL_OPACITY = 0.6;
const STROKE_OPACITY = 0.9;
const STROKE_WIDTH_RATIO = 0.15; // Stroke width as fraction of hold radius

/**
 * Renders SVG markers (or above-markers) for each active hold in a climb.
 *
 * Each hold gets a semi-transparent filled shape with a slightly more opaque
 * stroke border, matching the hold's role color from HOLD_STATE_MAP.
 */
const BoardHoldOverlay = React.memo(function BoardHoldOverlay({ holds }: BoardHoldOverlayProps) {
  return (
    <G>
      {holds.map((hold) => {
        const strokeWidth = Math.max(1, hold.radius * STROKE_WIDTH_RATIO * hold.brushThickness);

        if (hold.renderStyle === 'above-marker') {
          // Render an inverted triangle marker above the hold position
          const markerSize = hold.radius * 0.8;
          const topY = hold.cy - hold.radius - markerSize * 1.2;
          const points = [
            `${hold.cx - markerSize},${topY}`,
            `${hold.cx + markerSize},${topY}`,
            `${hold.cx},${topY + markerSize * 1.2}`,
          ].join(' ');

          return (
            <Polygon
              key={hold.id}
              points={points}
              fill={hold.color}
              fillOpacity={FILL_OPACITY}
              stroke={hold.color}
              strokeOpacity={STROKE_OPACITY}
              strokeWidth={strokeWidth}
            />
          );
        }

        return (
          <HoldMarkerShapeElement
            key={hold.id}
            shape={hold.shape}
            cx={hold.cx}
            cy={hold.cy}
            radius={hold.radius * hold.shapeSize}
            color={hold.color}
            fillOpacity={FILL_OPACITY}
            strokeOpacity={STROKE_OPACITY}
            strokeWidth={strokeWidth}
          />
        );
      })}
    </G>
  );
});

export { BoardHoldOverlay };
