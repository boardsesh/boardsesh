import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import type { SprayLedPlacement } from '@boardsesh/spray-wall-geometry';
import { useTheme } from '../../providers/theme-provider';

// A climbing hold silhouette with an inset grip and a central mounting bolt.
const holdOutline = 'M22 54C20 43 29 30 42 28C55 23 72 32 78 45C84 57 73 69 59 71C43 75 25 68 22 54Z';

/** Diagram only: illustrative LED positions, not a physical wiring map. */
export function LedPlacementThumbnail({ placement }: { placement: SprayLedPlacement }) {
  const { systemColors, brandColors } = useTheme();
  const sideLighting = placement === 'sides';
  const lights = sideLighting
    ? [
        [16, 50],
        [84, 50],
      ]
    : placement === 'below'
      ? [[50, 82]]
      : [[50, 50]];
  return (
    <Svg width="100%" height="100%" viewBox="0 0 100 100" accessible={false}>
      <Rect width={100} height={100} rx={8} fill={systemColors.tertiaryGroupedBackground} />
      {sideLighting ? (
        <Path d={holdOutline} fill={brandColors.primary} opacity={0.16} stroke={brandColors.primary} strokeWidth={10} />
      ) : null}
      <Path
        d={holdOutline}
        fill={sideLighting ? brandColors.primary : systemColors.secondaryLabel}
        fillOpacity={sideLighting ? 0.2 : 0.22}
        stroke={sideLighting ? brandColors.primary : systemColors.secondaryLabel}
        strokeWidth={1.5}
      />
      <Path
        d="M31 43C41 34 61 33 70 45"
        fill="none"
        stroke={systemColors.secondaryLabel}
        strokeWidth={2}
        opacity={0.5}
      />
      <Circle
        cx={50}
        cy={50}
        r={3}
        fill={systemColors.tertiaryGroupedBackground}
        stroke={systemColors.secondaryLabel}
      />
      {lights.map(([x, y]) => (
        <G key={`${x}:${y}`}>
          <Circle cx={x} cy={y} r={9} fill={brandColors.primary} opacity={0.12} />
          <Circle cx={x} cy={y} r={6} fill={brandColors.primary} opacity={0.24} />
          <Circle cx={x} cy={y} r={3.5} fill={brandColors.primary} />
          <Circle cx={x} cy={y} r={1.4} fill={systemColors.tertiaryGroupedBackground} />
        </G>
      ))}
    </Svg>
  );
}
