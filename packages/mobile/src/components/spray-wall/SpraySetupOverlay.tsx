import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import type { LedPosition, SprayLedPair, TnutPoint, TnutWiring } from '@boardsesh/spray-wall-geometry';
import { useTheme } from '../../providers/theme-provider';
import type { SprayLiveDrag } from './SprayPhotoCanvas';
import { sprayCableDisplayGeometry } from './spray-cable-display';

/** One empty list for every render without pairs, so `pairPoints` stays memoised. */
const NO_LED_PAIRS: readonly SprayLedPair[] = [];
const AnimatedPath = Animated.createAnimatedComponent(Path);
// Cable colour is separate from the orange holes and violet LEDs. Skipped LEDs are
// small dots in the cable colour, so red stays for loose ends that need fixing.
export const SPRAY_CABLE_COLOR = '#0891B2';
const SPRAY_PAIR_CONNECTION_COLOR = '#FBBF24';
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
  override: SprayLiveDrag | null = null,
): string {
  'worklet';
  let path = '';
  for (let index = 0; index < points.length; index++) {
    const point = override && override.index === index ? override : points[index];
    const screen = screenPoint(point, width, height, zoom, panX, panY);
    if (screen.x < -radius || screen.y < -radius || screen.x > width + radius || screen.y > height + radius) continue;
    path += circlePath(screen.x, screen.y, radius);
  }
  return path;
}
/** Draw paired rings, or the link between the rings once they no longer overlap. */
function pairPath(
  pairs: readonly (readonly [TnutPoint, TnutPoint])[],
  width: number,
  height: number,
  zoom: number,
  panX: number,
  panY: number,
  connector = false,
): string {
  'worklet';
  let path = '';
  for (let index = 0; index < pairs.length; index++) {
    const first = screenPoint(pairs[index][0], width, height, zoom, panX, panY);
    const second = screenPoint(pairs[index][1], width, height, zoom, panX, panY);
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const distance = Math.hypot(dx, dy);
    const radius = Math.max(6, Math.min(14, distance * 0.65));
    if (Math.max(first.x, second.x) < -radius || Math.min(first.x, second.x) > width + radius) continue;
    if (Math.max(first.y, second.y) < -radius || Math.min(first.y, second.y) > height + radius) continue;
    if (connector) {
      if (distance <= radius * 2) continue;
      const offsetX = (dx * radius) / distance;
      const offsetY = (dy * radius) / distance;
      path += `M${first.x + offsetX} ${first.y + offsetY}L${second.x - offsetX} ${second.y - offsetY}`;
    } else {
      path += circlePath(first.x, first.y, radius) + circlePath(second.x, second.y, radius);
    }
  }
  return path;
}
function arrowHead(from: TnutPoint, to: TnutPoint, length: number, width: number): string {
  'worklet';
  const dx = to.x - from.x,
    dy = to.y - from.y,
    distance = Math.hypot(dx, dy);
  if (distance < 12) return '';
  const x = from.x + dx * 0.6,
    y = from.y + dy * 0.6,
    ux = dx / distance,
    uy = dy / distance;
  return `M${x - ux * length - uy * width} ${y - uy * length + ux * width}L${x} ${y}L${x - ux * length + uy * width} ${y - uy * length - ux * width}`;
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
  showSkips = true,
  distinguishSkips = false,
  selected = [],
  holdRings,
  selectedHoldIds = [],
  selectedHoles = [],
  compactHoles = false,
  liveDrag,
  liveDragTarget,
  subtleLeds = false,
  unmappedHoles = [],
  unmappedHoldIds = [],
  ledPairs = NO_LED_PAIRS,
  showPairConnectors = false,
  width,
  height,
  zoom,
  panX,
  panY,
}: {
  holes: TnutPoint[];
  /** Fade the LED dots so holds and selections stay readable (Test LEDs). */
  subtleLeds?: boolean;
  /** Holes with no LED; drawn with a red ring. */
  unmappedHoles?: TnutPoint[];
  /** Holds with no LED; their outline is drawn red. */
  unmappedHoldIds?: number[];
  /** LED pairs behind one hold, drawn as interlocking rings. */
  ledPairs?: readonly SprayLedPair[];
  /** In the position editor, link separated pair rings with a dashed line. */
  showPairConnectors?: boolean;
  /** Draw holes small and faded so the LEDs stay readable (LED and cable editors). */
  compactHoles?: boolean;
  /** A point being dragged right now; drawn at the finger until the move commits. */
  liveDrag?: SharedValue<SprayLiveDrag | null>;
  liveDragTarget?: 'holes' | 'leds';
  leds?: LedPosition[];
  wiring?: TnutWiring;
  /** Hide skipped slots in the cable editor without changing the stored wiring. */
  showSkips?: boolean;
  /** Skipped physical slots stand out from the cable in the skip editor. */
  distinguishSkips?: boolean;
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
  const { edges, gapEdges, cableStarts, cableEnds, looseEnds } = useMemo(() => {
    const { edges, start, end, loose } = sprayCableDisplayGeometry(leds, wiring, ledPairs);
    return {
      edges,
      gapEdges: showSkips ? edges.filter((edge) => edge.skip > 0) : [],
      cableStarts: start ? [start] : [],
      cableEnds: end ? [end] : [],
      looseEnds: loose,
    };
  }, [leds, wiring, ledPairs, showSkips]);
  const selectedLeds = useMemo(() => {
    const selection = new Set(selected);
    return leds.filter((point) => selection.has(point.id));
  }, [leds, selected]);
  const smallHoles = Boolean(wiring) || compactHoles;
  const holeRadius = smallHoles ? 3 : 7;
  const selectedRings = useMemo(() => {
    const selection = new Set(selectedHoldIds);
    return holdRings?.filter((ring) => selection.has(ring.id)) ?? [];
  }, [holdRings, selectedHoldIds]);
  const { mappedRings, unmappedRings } = useMemo(() => {
    const unmapped = new Set(unmappedHoldIds);
    const rings = holdRings ?? [];
    return {
      mappedRings: rings.filter((ring) => !unmapped.has(ring.id)),
      unmappedRings: rings.filter((ring) => unmapped.has(ring.id)),
    };
  }, [holdRings, unmappedHoldIds]);
  const outlineProps = useAnimatedProps(() => ({
    d: outlinePath(mappedRings, width, height, zoom.value, panX.value, panY.value),
  }));
  const unmappedOutlineProps = useAnimatedProps(() => ({
    d: outlinePath(unmappedRings, width, height, zoom.value, panX.value, panY.value),
  }));
  const unmappedHoleProps = useAnimatedProps(() => ({
    d: circles(unmappedHoles, width, height, zoom.value, panX.value, panY.value, 9),
  }));
  const selectedOutlineProps = useAnimatedProps(() => ({
    d: outlinePath(selectedRings, width, height, zoom.value, panX.value, panY.value),
  }));
  const selectedHoleProps = useAnimatedProps(() => ({
    d: circles(selectedHoles, width, height, zoom.value, panX.value, panY.value, 11),
  }));
  const holeProps = useAnimatedProps(() => ({
    d: circles(
      holes,
      width,
      height,
      zoom.value,
      panX.value,
      panY.value,
      holeRadius,
      liveDragTarget === 'holes' ? (liveDrag?.value ?? null) : null,
    ),
  }));
  const pairPoints = useMemo(() => {
    const byId = new Map(leds.map((led) => [led.id, led]));
    return ledPairs.flatMap(([first, second]) => {
      const firstLed = byId.get(first),
        secondLed = byId.get(second);
      return firstLed && secondLed ? [[firstLed, secondLed] as const] : [];
    });
  }, [leds, ledPairs]);
  const pairProps = useAnimatedProps(() => ({
    d: pairPath(pairPoints, width, height, zoom.value, panX.value, panY.value),
  }));
  const pairConnectorProps = useAnimatedProps(() => ({
    d: showPairConnectors ? pairPath(pairPoints, width, height, zoom.value, panX.value, panY.value, true) : '',
  }));
  const ledProps = useAnimatedProps(() => ({
    d: circles(
      leds,
      width,
      height,
      zoom.value,
      panX.value,
      panY.value,
      4,
      liveDragTarget === 'leds' ? (liveDrag?.value ?? null) : null,
    ),
  }));
  const selectedProps = useAnimatedProps(() => ({
    d: circles(selectedLeds, width, height, zoom.value, panX.value, panY.value, 10),
  }));
  const cableProps = useAnimatedProps(() => {
    let path = '';
    for (const edge of edges) {
      if (showSkips && edge.skip) continue;
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
      if ((showSkips && edge.skip) || edge.first) continue;
      const from = screenPoint(edge.from, width, height, zoom.value, panX.value, panY.value),
        to = screenPoint(edge.to, width, height, zoom.value, panX.value, panY.value);
      if (visibleEdge(from, to, width, height)) path += arrowHead(from, to, 5, 3);
    }
    return { d: path };
  });
  // The first LED of each cable run gets a green ring and a larger green arrow,
  // so the climber can see where the data line enters the strip.
  const startArrowProps = useAnimatedProps(() => {
    let path = '';
    for (const edge of edges) {
      if ((showSkips && edge.skip) || !edge.first) continue;
      const from = screenPoint(edge.from, width, height, zoom.value, panX.value, panY.value),
        to = screenPoint(edge.to, width, height, zoom.value, panX.value, panY.value);
      if (visibleEdge(from, to, width, height)) path += arrowHead(from, to, 8, 5);
    }
    return { d: path };
  });
  const startRingProps = useAnimatedProps(() => ({
    d: circles(cableStarts, width, height, zoom.value, panX.value, panY.value, 8),
  }));
  const endRingProps = useAnimatedProps(() => ({
    d: circles(cableEnds, width, height, zoom.value, panX.value, panY.value, 8),
  }));
  const looseRingProps = useAnimatedProps(() => ({
    d: circles(looseEnds, width, height, zoom.value, panX.value, panY.value, 8),
  }));
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
      <AnimatedPath
        animatedProps={gapLineProps}
        fill="none"
        stroke={distinguishSkips ? brandColors.error : SPRAY_CABLE_COLOR}
        strokeWidth={2}
      />
      <AnimatedPath animatedProps={arrowProps} fill="none" stroke={SPRAY_CABLE_COLOR} strokeWidth={2} />
      <AnimatedPath
        animatedProps={gapProps}
        fill={distinguishSkips ? brandColors.error : SPRAY_CABLE_COLOR}
        stroke={brandColors.onPrimary}
        strokeWidth={1}
      />
      <AnimatedPath
        animatedProps={holeProps}
        fill="none"
        stroke={brandColors.warning}
        strokeWidth={smallHoles ? 1 : 1.5}
        opacity={smallHoles ? 0.45 : 1}
      />
      <AnimatedPath
        animatedProps={ledProps}
        fill={brandColors.primary}
        stroke={brandColors.onPrimary}
        strokeWidth={1.8}
        opacity={subtleLeds ? 0.4 : 1}
      />
      {pairPoints.length ? (
        <AnimatedPath
          animatedProps={pairProps}
          fill="none"
          stroke={brandColors.primary}
          strokeWidth={1.5}
          opacity={subtleLeds ? 0.4 : 1}
        />
      ) : null}
      {showPairConnectors && pairPoints.length ? (
        <AnimatedPath
          animatedProps={pairConnectorProps}
          fill="none"
          stroke={SPRAY_PAIR_CONNECTION_COLOR}
          strokeWidth={1.5}
          strokeDasharray={[4, 3]}
        />
      ) : null}
      {unmappedHoles.length ? (
        <AnimatedPath
          animatedProps={unmappedHoleProps}
          fill="none"
          stroke={brandColors.error}
          strokeWidth={2}
          strokeDasharray={[3, 2]}
        />
      ) : null}
      {cableStarts.length ? (
        <>
          <AnimatedPath animatedProps={startRingProps} fill="none" stroke={brandColors.success} strokeWidth={2.5} />
          <AnimatedPath animatedProps={startArrowProps} fill="none" stroke={brandColors.success} strokeWidth={2.5} />
        </>
      ) : null}
      {cableEnds.length ? (
        <AnimatedPath animatedProps={endRingProps} fill="none" stroke={SPRAY_CABLE_COLOR} strokeWidth={2.5} />
      ) : null}
      {looseEnds.length ? (
        <AnimatedPath animatedProps={looseRingProps} fill="none" stroke={brandColors.error} strokeWidth={2.5} />
      ) : null}
      <AnimatedPath animatedProps={selectedProps} fill="none" stroke={brandColors.primary} strokeWidth={2.5} />
      {holdRings ? (
        <>
          <AnimatedPath animatedProps={outlineProps} fill="none" stroke={brandColors.warning} strokeWidth={1.5} />
          <AnimatedPath
            animatedProps={unmappedOutlineProps}
            fill="none"
            stroke={brandColors.error}
            strokeWidth={2}
            strokeDasharray={[4, 3]}
          />
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
