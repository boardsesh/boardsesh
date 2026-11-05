import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useTheme } from '../../providers/theme-provider';
import type { CableDirection } from '@boardsesh/spray-wall-geometry';
/** One continuous cable snakes between all positions, rather than independent parallel runs. */
export function CablePatternThumbnail({ direction }: { direction: CableDirection }) {
  const { systemColors, brandColors } = useTheme();
  const horizontal = 'M20 20H80V50H20V80H80';
  const vertical = 'M20 20V80H50V20H80V80';
  const custom = 'M20 20L50 50L80 20V80L20 80';
  return (
    <Svg width="100%" height="100%" viewBox="0 0 100 100">
      <Rect width={100} height={100} rx={8} fill={systemColors.tertiaryGroupedBackground} />
      <Path
        d={direction === 'horizontal' ? horizontal : direction === 'vertical' ? vertical : custom}
        stroke={brandColors.primary}
        strokeWidth={3}
        fill="none"
      />
      {[20, 50, 80].flatMap((y) =>
        [20, 50, 80].map((x) => (
          <Circle key={`${x}:${y}`} cx={x} cy={y} r={4} fill={brandColors.primary} stroke={brandColors.onPrimary} />
        )),
      )}
    </Svg>
  );
}
