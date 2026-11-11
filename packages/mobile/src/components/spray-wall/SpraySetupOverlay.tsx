import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import type { LedPosition, TnutPoint, TnutWiring } from '@boardsesh/spray-wall-geometry';
import { useTheme } from '../../providers/theme-provider';
const AnimatedPath = Animated.createAnimatedComponent(Path);
// Cable colour is separate from the orange holes and violet addressable LEDs.
export const SPRAY_CABLE_COLOR = '#0891B2';
type Edge = { from: TnutPoint; to: TnutPoint; skip: number };
export type SprayHoldRing = { id: number; points: TnutPoint[] };
function screenPoint(
  point: TnutPoint,
  width: number,
  height: number,
  zoom: number,
  panX: number,
  panY: number,
): TnutPoint {
  'worklet';
  return {
    x: width / 2 + (point.x - 0.5) * width * zoom + panX,
    y: height / 2 + (point.y - 0.5) * height * zoom + panY,
  };
}
function circlePath(x: number, y: number, radius: number): string {
  'worklet';
  return `M${x - radius} ${y}a${radius} ${radius} 0 1 0 ${radius * 2} 0a${radius} ${radius} 0 1 0 ${-radius * 2} 0`;
}
function circles(
  points: readonly TnutPoint[],
  width: number,
  height: number,
  zoom: number,
  panX: number,
  panY: number,
  radius: number,
): string {
  'worklet';
  let path = '';
  for (const point of points) {
    const screen = screenPoint(point, width, height, zoom, panX, panY);
    if (screen.x < -radius || screen.y < -radius || screen.x > width + radius || screen.y > height + radius) continue;
    path += circlePath(screen.x, screen.y, radius);
  }
  return path;
}
function visibleEdge(from: TnutPoint, to: TnutPoint, width: number, height: number): boolean {
  'worklet';
  return (
    Math.max(from.x, to.x) >= 0 &&
    Math.min(from.x, to.x) <= width &&
    Math.max(from.y, to.y) >= 0 &&
    Math.min(from.y, to.y) <= height
  );
}
function outlinePath(
  rings: readonly SprayHoldRing[],
  width: number,
  height: number,
  zoom: number,
  panX: number,
  panY: number,
): string {
  'worklet';
  let path = '';
  for (const ring of rings) {
    for (let index = 0; index < ring.points.length; index++) {
      const point = screenPoint(ring.points[index], width, height, zoom, panX, panY);
      path += `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`;
    }
    path += 'Z';
  }
  return path;
}
export function SpraySetupOverlay({
  holes,
  leds = [],
  wiring,
  selected = [],
  holdRings,
  selectedHoldIds = [],
  selectedHoles = [],
  width,
  height,
  zoom,
  panX,
  panY,
}: {
  holes: TnutPoint[];
  leds?: LedPosition[];
  wiring?: TnutWiring;
  selected?: string[];
  holdRings?: SprayHoldRing[];
  selectedHoldIds?: number[];
  selectedHoles?: TnutPoint[];
  width: number;
  height: number;
  zoom: SharedValue<number>;
  panX: SharedValue<number>;
  panY: SharedValue<number>;
}) {
  const { brandColors } = useTheme();
  const { edges, gapEdges, selectedLeds } = useMemo(() => {
    const byId = new Map(leds.map((point) => [point.id, point]));
    const skips = new Map<string, number>();
    for (const skip of wiring?.skips ?? []) {
      skips.set(JSON.stringify([skip.from, skip.to]), skip.count);
      skips.set(JSON.stringify([skip.to, skip.from]), skip.count);
    }
    const edges: Edge[] = [],
      gapEdges: Edge[] = [];
    for (const path of wiring?.paths ?? [])
      for (let index = 1; index < path.length; index++) {
        const from = byId.get(path[index - 1]),
          to = byId.get(path[index]);
        if (!from || !to) continue;
        const edge = { from, to, skip: skips.get(JSON.stringify([from.id, to.id])) ?? 0 };
        edges.push(edge);
        if (edge.skip > 0) gapEdges.push(edge);
      }
    const selection = new Set(selected);
    return { edges, gapEdges, selectedLeds: leds.filter((point) => selection.has(point.id)) };
  }, [leds, wiring, selected]);
  const holeRadius = wiring ? 3 : 7;
  const selectedRings = useMemo(() => {
    const selection = new Set(selectedHoldIds);
    return holdRings?.filter((ring) => selection.has(ring.id)) ?? [];
  }, [holdRings, selectedHoldIds]);
  const outlineProps = useAnimatedProps(() => ({
    d: outlinePath(holdRings ?? [], width, height, zoom.value, panX.value, panY.value),
  }));
  const selectedOutlineProps = useAnimatedProps(() => ({
    d: outlinePath(selectedRings, width, height, zoom.value, panX.value, panY.value),
  }));
  const selectedHoleProps = useAnimatedProps(() => ({
    d: circles(selectedHoles, width, height, zoom.value, panX.value, panY.value, 11),
  }));
  const holeProps = useAnimatedProps(() => ({
    d: circles(holes, width, height, zoom.value, panX.value, panY.value, holeRadius),
  }));
  const ledProps = useAnimatedProps(() => ({ d: circles(leds, width, height, zoom.value, panX.value, panY.value, 4) }));
  const selectedProps = useAnimatedProps(() => ({
    d: circles(selectedLeds, width, height, zoom.value, panX.value, panY.value, 10),
  }));
  const cableProps = useAnimatedProps(() => {
    let path = '';
    for (const edge of edges) {
      if (edge.skip) continue;
      const from = screenPoint(edge.from, width, height, zoom.value, panX.value, panY.value),
        to = screenPoint(edge.to, width, height, zoom.value, panX.value, panY.value);
      if (visibleEdge(from, to, width, height)) path += `M${from.x} ${from.y}L${to.x} ${to.y}`;
    }
    return { d: path };
  });
  const gapLineProps = useAnimatedProps(() => {
    let path = '';
    for (const edge of gapEdges) {
      const from = screenPoint(edge.from, width, height, zoom.value, panX.value, panY.value),
        to = screenPoint(edge.to, width, height, zoom.value, panX.value, panY.value);
      if (visibleEdge(from, to, width, height)) path += `M${from.x} ${from.y}L${to.x} ${to.y}`;
    }
    return { d: path };
  });
  const arrowProps = useAnimatedProps(() => {
    let path = '';
    for (const edge of edges) {
      if (edge.skip) continue;
      const from = screenPoint(edge.from, width, height, zoom.value, panX.value, panY.value),
        to = screenPoint(edge.to, width, height, zoom.value, panX.value, panY.value);
      const dx = to.x - from.x,
        dy = to.y - from.y,
        length = Math.hypot(dx, dy);
      if (length < 12 || !visibleEdge(from, to, width, height)) continue;
      const x = from.x + dx * 0.6,
        y = from.y + dy * 0.6,
        ux = dx / length,
        uy = dy / length;
      path += `M${x - ux * 5 - uy * 3} ${y - uy * 5 + ux * 3}L${x} ${y}L${x - ux * 5 + uy * 3} ${y - uy * 5 - ux * 3}`;
    }
    return { d: path };
  });
  const gapProps = useAnimatedProps(() => {
    let path = '',
      rendered = 0;
    for (const edge of gapEdges) {
      const from = screenPoint(edge.from, width, height, zoom.value, panX.value, panY.value),
        to = screenPoint(edge.to, width, height, zoom.value, panX.value, panY.value);
      if (!visibleEdge(from, to, width, height)) continue;
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      // Keep true integer LED slots. At dense zoom levels, omit overlapping dots;
      // zooming in reveals them. The cable and stored count remain exact.
      const spacing = length / (edge.skip + 1);
      const radius = Math.max(0.6, Math.min(3, spacing * 0.38));
      const stride = Math.max(1, Math.ceil(1.5 / Math.max(0.1, spacing)));
      for (let index = 1; index <= edge.skip && rendered < 4096; index += stride) {
        const fraction = index / (edge.skip + 1),
          x = from.x + (to.x - from.x) * fraction,
          y = from.y + (to.y - from.y) * fraction;
        if (x < -3 || y < -3 || x > width + 3 || y > height + 3) continue;
        path += circlePath(x, y, radius);
        rendered++;
      }
      if (rendered >= 4096) break;
    }
    return { d: path };
  });
  return (
    <Svg pointerEvents="none" width={width} height={height} style={StyleSheet.absoluteFill}>
      <AnimatedPath animatedProps={cableProps} fill="none" stroke={SPRAY_CABLE_COLOR} strokeWidth={2} />
      <AnimatedPath animatedProps={gapLineProps} fill="none" stroke={brandColors.error} strokeWidth={2} />
      <AnimatedPath animatedProps={arrowProps} fill="none" stroke={SPRAY_CABLE_COLOR} strokeWidth={2} />
      <AnimatedPath animatedProps={gapProps} fill={brandColors.error} stroke={brandColors.onPrimary} strokeWidth={1} />
      <AnimatedPath
        animatedProps={holeProps}
        fill="none"
        stroke={brandColors.warning}
        strokeWidth={wiring ? 1 : 1.5}
        opacity={wiring ? 0.45 : 1}
      />
      <AnimatedPath
        animatedProps={ledProps}
        fill={brandColors.primary}
        stroke={brandColors.onPrimary}
        strokeWidth={1.8}
      />
      <AnimatedPath animatedProps={selectedProps} fill="none" stroke={brandColors.primary} strokeWidth={2.5} />
      {holdRings ? (
        <>
          <AnimatedPath animatedProps={outlineProps} fill="none" stroke={brandColors.warning} strokeWidth={1.5} />
          <AnimatedPath
            animatedProps={selectedOutlineProps}
            fill={brandColors.primary}
            fillOpacity={0.2}
            stroke={brandColors.primary}
            strokeWidth={3}
          />
        </>
      ) : null}
      {selectedHoles.length ? (
        <AnimatedPath animatedProps={selectedHoleProps} fill="none" stroke={brandColors.warning} strokeWidth={3} />
      ) : null}
    </Svg>
  );
}
