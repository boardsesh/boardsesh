import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Path, Polygon, Rect } from 'react-native-svg';
import type { HoldMarkerShape } from '../../lib/hold-color-overrides';

// Per-shape scale applied to the marker radius so every shape ends up with the
// same filled AREA as a circle of that radius (issue #3204). The circle is the
// reference (1.0), so default board renders are unchanged; the others grow to
// match. Derived from each shape's area formula vs πr². MUST stay in sync with
// SHAPE_AREA_SCALE in packages/board-renderer/core/src/renderer.rs.
export const SHAPE_AREA_SCALE: Record<HoldMarkerShape, number> = {
  circle: 1,
  'triangle-up': 1.5552,
  'triangle-down': 1.5552,
  square: 1.0808,
  diamond: 1.2533,
  octagon: 1.0539,
};

// Largest area scale (triangle) — used to size the non-clipping SVG canvas so a
// grown shape's vertex isn't cut off.
const MAX_SHAPE_BOUND = 1.5552;

// How far (as a fraction of the scaled circumradius) to round triangle corners
// so they read as less spiky (issue #3204). Kept in sync with the Rust renderer.
const TRIANGLE_CORNER_RATIO = 0.2;

type Point = readonly [number, number];

// Regular octagon, flat top/bottom (stop-sign orientation): vertices at
// angle = π/8 + i·π/4. Shared geometry with the native Rust renderer.
function octagonPoints(cx: number, cy: number, radius: number): string {
  const points: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const angle = Math.PI / 8 + (i * Math.PI) / 4;
    points.push(`${cx + radius * Math.cos(angle)},${cy + radius * Math.sin(angle)}`);
  }
  return points.join(' ');
}

// A point `dist` along the edge from `from` toward `to`.
function towards(from: Point, to: Point, dist: number): Point {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  return [from[0] + (dx / len) * dist, from[1] + (dy / len) * dist];
}

// Rounded-corner path for a convex polygon: at each vertex, stop short of the
// corner and quad-curve through it (control point = the true vertex). Shared
// algorithm with the Rust renderer's rounded triangle.
function roundedPolygonPath(vertices: Point[], cornerRadius: number): string {
  const count = vertices.length;
  let path = '';
  for (let i = 0; i < count; i += 1) {
    const prev = vertices[(i - 1 + count) % count];
    const curr = vertices[i];
    const next = vertices[(i + 1) % count];
    const entry = towards(curr, prev, cornerRadius);
    const exit = towards(curr, next, cornerRadius);
    path += i === 0 ? `M ${entry[0]} ${entry[1]} ` : `L ${entry[0]} ${entry[1]} `;
    path += `Q ${curr[0]} ${curr[1]} ${exit[0]} ${exit[1]} `;
  }
  return `${path}Z`;
}

function triangleVertices(shape: 'triangle-up' | 'triangle-down', cx: number, cy: number, r: number): Point[] {
  if (shape === 'triangle-up') {
    return [
      [cx, cy - r],
      [cx + r * 0.866, cy + r * 0.5],
      [cx - r * 0.866, cy + r * 0.5],
    ];
  }
  return [
    [cx - r * 0.866, cy - r * 0.5],
    [cx + r * 0.866, cy - r * 0.5],
    [cx, cy + r],
  ];
}

type HoldMarkerShapeElementProps = {
  shape: HoldMarkerShape;
  cx: number;
  cy: number;
  radius: number;
  color: string;
  fillOpacity?: number;
  strokeOpacity?: number;
  strokeWidth: number;
  /**
   * Scale each shape to equal filled area (issue #3204). On for single markers
   * (board overlay, selector swatches). The search filter's CONCENTRIC rings
   * pass false so they keep equal circumradius and nest cleanly.
   */
  equalArea?: boolean;
};

export function HoldMarkerShapeElement({
  shape,
  cx,
  cy,
  radius,
  color,
  fillOpacity = 0,
  strokeOpacity = 1,
  strokeWidth,
  equalArea = true,
}: HoldMarkerShapeElementProps) {
  // Equal-area scaling: every shape covers the same area as a circle of `radius`.
  const r = radius * (equalArea ? (SHAPE_AREA_SCALE[shape] ?? 1) : 1);

  if (shape === 'circle') {
    return (
      <Circle
        cx={cx}
        cy={cy}
        r={r}
        fill={color}
        fillOpacity={fillOpacity}
        stroke={color}
        strokeOpacity={strokeOpacity}
        strokeWidth={strokeWidth}
      />
    );
  }

  if (shape === 'triangle-up' || shape === 'triangle-down') {
    return (
      <Path
        d={roundedPolygonPath(triangleVertices(shape, cx, cy, r), r * TRIANGLE_CORNER_RATIO)}
        fill={color}
        fillOpacity={fillOpacity}
        stroke={color}
        strokeLinejoin="round"
        strokeOpacity={strokeOpacity}
        strokeWidth={strokeWidth}
      />
    );
  }

  if (shape === 'square') {
    const halfSide = r * 0.82;
    return (
      <Rect
        x={cx - halfSide}
        y={cy - halfSide}
        width={halfSide * 2}
        height={halfSide * 2}
        fill={color}
        fillOpacity={fillOpacity}
        stroke={color}
        strokeLinejoin="round"
        strokeOpacity={strokeOpacity}
        strokeWidth={strokeWidth}
      />
    );
  }

  if (shape === 'octagon') {
    return (
      <Polygon
        points={octagonPoints(cx, cy, r)}
        fill={color}
        fillOpacity={fillOpacity}
        stroke={color}
        strokeLinejoin="round"
        strokeOpacity={strokeOpacity}
        strokeWidth={strokeWidth}
      />
    );
  }

  // diamond (and any unknown shape) — rotated square on its point.
  return (
    <Polygon
      points={`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`}
      fill={color}
      fillOpacity={fillOpacity}
      stroke={color}
      strokeLinejoin="round"
      strokeOpacity={strokeOpacity}
      strokeWidth={strokeWidth}
    />
  );
}

type HoldMarkerShapeSvgProps = {
  shape: HoldMarkerShape;
  color: string;
  diameter: number;
  strokeWidth: number;
  fillOpacity?: number;
  strokeOpacity?: number;
  style?: StyleProp<ViewStyle>;
  pointerEvents?: ViewStyle['pointerEvents'];
  /** See HoldMarkerShapeElement.equalArea. */
  equalArea?: boolean;
};

export function HoldMarkerShapeSvg({
  shape,
  color,
  diameter,
  strokeWidth,
  fillOpacity = 0,
  strokeOpacity = 1,
  style,
  pointerEvents,
  equalArea = true,
}: HoldMarkerShapeSvgProps) {
  const safeDiameter = Math.max(1, diameter);
  const safeStrokeWidth = Math.max(0, strokeWidth);
  const center = safeDiameter / 2;
  // Nominal (equal-area-circle) radius — circle renders exactly here; the other
  // shapes are area-scaled up inside HoldMarkerShapeElement.
  const radius = Math.max(0.5, center - safeStrokeWidth / 2);

  // The area-scaled shapes (triangle is the largest) extend past `diameter`, and
  // an SVG clips to its own bounds, so draw on an oversized canvas centered in a
  // `diameter`-footprint View. RN View overflow is visible by default, so the
  // shape bleeds out symmetrically instead of clipping, and consumer layout
  // (which sizes by `diameter`) is unchanged. When equalArea is off no shape
  // exceeds `diameter`, but the centered oversized canvas is still harmless.
  const canvasSize = Math.ceil(radius * 2 * MAX_SHAPE_BOUND + safeStrokeWidth);
  const canvasCenter = canvasSize / 2;

  return (
    <View
      style={[{ width: safeDiameter, height: safeDiameter, alignItems: 'center', justifyContent: 'center' }, style]}
      pointerEvents={pointerEvents}
    >
      <Svg width={canvasSize} height={canvasSize} viewBox={`0 0 ${canvasSize} ${canvasSize}`} pointerEvents="none">
        <HoldMarkerShapeElement
          shape={shape}
          cx={canvasCenter}
          cy={canvasCenter}
          radius={radius}
          color={color}
          fillOpacity={fillOpacity}
          strokeOpacity={strokeOpacity}
          strokeWidth={safeStrokeWidth}
          equalArea={equalArea}
        />
      </Svg>
    </View>
  );
}
