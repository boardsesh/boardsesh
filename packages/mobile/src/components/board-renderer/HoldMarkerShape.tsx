import React from 'react';
import Svg, { Circle, Polygon, Rect, type SvgProps } from 'react-native-svg';
import type { HoldMarkerShape } from '../../lib/hold-color-overrides';

type HoldMarkerShapeElementProps = {
  shape: HoldMarkerShape;
  cx: number;
  cy: number;
  radius: number;
  color: string;
  fillOpacity?: number;
  strokeOpacity?: number;
  strokeWidth: number;
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
}: HoldMarkerShapeElementProps) {
  if (shape === 'circle') {
    return (
      <Circle
        cx={cx}
        cy={cy}
        r={radius}
        fill={color}
        fillOpacity={fillOpacity}
        stroke={color}
        strokeOpacity={strokeOpacity}
        strokeWidth={strokeWidth}
      />
    );
  }

  if (shape === 'triangle-up') {
    return (
      <Polygon
        points={`${cx},${cy - radius} ${cx + radius * 0.866},${cy + radius * 0.5} ${cx - radius * 0.866},${
          cy + radius * 0.5
        }`}
        fill={color}
        fillOpacity={fillOpacity}
        stroke={color}
        strokeLinejoin="round"
        strokeOpacity={strokeOpacity}
        strokeWidth={strokeWidth}
      />
    );
  }

  if (shape === 'triangle-down') {
    return (
      <Polygon
        points={`${cx - radius * 0.866},${cy - radius * 0.5} ${cx + radius * 0.866},${cy - radius * 0.5} ${cx},${
          cy + radius
        }`}
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
    const halfSide = radius * 0.82;
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

  return (
    <Polygon
      points={`${cx},${cy - radius} ${cx + radius},${cy} ${cx},${cy + radius} ${cx - radius},${cy}`}
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
  style?: SvgProps['style'];
  pointerEvents?: SvgProps['pointerEvents'];
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
}: HoldMarkerShapeSvgProps) {
  const safeDiameter = Math.max(1, diameter);
  const safeStrokeWidth = Math.max(0, strokeWidth);
  const center = safeDiameter / 2;
  const radius = Math.max(0.5, center - safeStrokeWidth / 2);

  return (
    <Svg
      width={safeDiameter}
      height={safeDiameter}
      viewBox={`0 0 ${safeDiameter} ${safeDiameter}`}
      style={style}
      pointerEvents={pointerEvents}
    >
      <HoldMarkerShapeElement
        shape={shape}
        cx={center}
        cy={center}
        radius={radius}
        color={color}
        fillOpacity={fillOpacity}
        strokeOpacity={strokeOpacity}
        strokeWidth={safeStrokeWidth}
      />
    </Svg>
  );
}
