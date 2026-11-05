import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import Animated, { useAnimatedProps, type SharedValue } from 'react-native-reanimated';
import type { LedPosition, TnutPoint, TnutWiring } from '@boardsesh/spray-wall-geometry';
import { useTheme } from '../../providers/theme-provider';
const AnimatedPath = Animated.createAnimatedComponent(Path);
export function SpraySetupOverlay({
  holes,
  leds = [],
  wiring,
  selected = [],
  width,
  height,
  zoom,
}: {
  holes: TnutPoint[];
  leds?: LedPosition[];
  wiring?: TnutWiring;
  selected?: string[];
  width: number;
  height: number;
  zoom: SharedValue<number>;
}) {
  const { brandColors } = useTheme();
  const holeProps = useAnimatedProps(() => ({
    d: holes
      .map(({ x, y }) => {
        const radius = 7 / zoom.value;
        return `M${x * width - radius} ${y * height}a${radius} ${radius} 0 1 0 ${radius * 2} 0a${radius} ${radius} 0 1 0 ${-radius * 2} 0`;
      })
      .join(''),
    strokeWidth: 1.5 / zoom.value,
  }));
  const ledProps = useAnimatedProps(() => ({
    d: leds
      .map(({ x, y }) => {
        const radius = 4 / zoom.value;
        return `M${x * width - radius} ${y * height}a${radius} ${radius} 0 1 0 ${radius * 2} 0a${radius} ${radius} 0 1 0 ${-radius * 2} 0`;
      })
      .join(''),
    strokeWidth: 1.8 / zoom.value,
  }));
  const selectedProps = useAnimatedProps(() => ({
    d: leds
      .filter((point) => selected.includes(point.id))
      .map(({ x, y }) => {
        const radius = 10 / zoom.value;
        return `M${x * width - radius} ${y * height}a${radius} ${radius} 0 1 0 ${radius * 2} 0a${radius} ${radius} 0 1 0 ${-radius * 2} 0`;
      })
      .join(''),
    strokeWidth: 2.5 / zoom.value,
  }));
  const { cable, gaps, edges } = useMemo(() => {
    const byId = new Map(leds.map((point) => [point.id, point]));
    const edges: { from: TnutPoint; to: TnutPoint; gap: boolean }[] = [];
    let cable = '',
      gaps = '';
    for (const path of wiring?.paths ?? [])
      for (let index = 1; index < path.length; index++) {
        const a = byId.get(path[index - 1]),
          b = byId.get(path[index]);
        if (!a || !b) continue;
        const isGap = Boolean(
          wiring?.skips.some(
            (skip) => (skip.from === a.id && skip.to === b.id) || (skip.from === b.id && skip.to === a.id),
          ),
        );
        edges.push({ from: a, to: b, gap: isGap });
        const segment = `M${a.x * width} ${a.y * height}L${b.x * width} ${b.y * height}`;
        if (
          wiring?.skips.some(
            (skip) => (skip.from === a.id && skip.to === b.id) || (skip.from === b.id && skip.to === a.id),
          )
        )
          gaps += segment;
        else cable += segment;
      }
    return { cable, gaps, edges };
  }, [leds, wiring, width, height]);
  const cableProps = useAnimatedProps(() => ({ strokeWidth: 2 / zoom.value }));
  const arrowProps = useAnimatedProps(() => ({
    d: edges
      .map(({ from, to }) => {
        const dx = (to.x - from.x) * width,
          dy = (to.y - from.y) * height,
          length = Math.hypot(dx, dy);
        if (length < 12 / zoom.value) return '';
        const x = from.x * width + dx * 0.6,
          y = from.y * height + dy * 0.6,
          size = 5 / zoom.value,
          ux = dx / length,
          uy = dy / length;
        return `M${x - ux * size - uy * size * 0.6} ${y - uy * size + ux * size * 0.6}L${x} ${y}L${x - ux * size + uy * size * 0.6} ${y - uy * size - ux * size * 0.6}`;
      })
      .join(''),
    strokeWidth: 2 / zoom.value,
  }));
  const gapProps = useAnimatedProps(() => ({
    d: edges
      .filter((edge) => edge.gap)
      .map(({ from, to }) => {
        const x = ((from.x + to.x) * width) / 2,
          y = ((from.y + to.y) * height) / 2,
          size = 5 / zoom.value;
        return `M${x - size} ${y}L${x} ${y - size}L${x + size} ${y}L${x} ${y + size}Z`;
      })
      .join(''),
    strokeWidth: 1.5 / zoom.value,
  }));
  return (
    <Svg pointerEvents="none" width={width} height={height} style={StyleSheet.absoluteFill}>
      <AnimatedPath d={cable} animatedProps={cableProps} fill="none" stroke={brandColors.primary} />
      <AnimatedPath
        d={gaps}
        animatedProps={cableProps}
        fill="none"
        stroke={brandColors.warning}
        strokeDasharray="5 4"
      />
      <AnimatedPath animatedProps={arrowProps} fill="none" stroke={brandColors.primary} />
      <AnimatedPath animatedProps={gapProps} fill={brandColors.warning} stroke={brandColors.onPrimary} />
      <AnimatedPath animatedProps={holeProps} fill="none" stroke={brandColors.warning} />
      <AnimatedPath animatedProps={ledProps} fill={brandColors.primary} stroke={brandColors.onPrimary} />
      <AnimatedPath animatedProps={selectedProps} fill="none" stroke={brandColors.primary} />
    </Svg>
  );
}
