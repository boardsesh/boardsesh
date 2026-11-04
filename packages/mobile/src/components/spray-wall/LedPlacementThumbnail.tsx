import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import { generateTnutGrid, type SprayLedPlacement } from '@boardsesh/spray-wall-geometry';
import { useTheme } from '../../providers/theme-provider';

// A climbing hold silhouette with an inset grip and a central mounting bolt.
const holdOutline = 'M22 54C20 43 29 30 42 28C55 23 72 32 78 45C84 57 73 69 59 71C43 75 25 68 22 54Z';

/** Diagram only: illustrative LED positions, not a physical wiring map. */
export function LedPlacementThumbnail({
  placement,
  firstRowOffset = false,
}: {
  placement: SprayLedPlacement;
  firstRowOffset?: boolean;
}) {
  const { systemColors, brandColors } = useTheme();
  if (placement === 'alternating') return <AlternatingThumbnail firstRowOffset={firstRowOffset} />;
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

function AlternatingThumbnail({ firstRowOffset }: { firstRowOffset: boolean }) {
  const { systemColors, brandColors } = useTheme();
  const grid = {
    pattern: 'offset' as const,
    rows: 3,
    columns: 3,
    corners: {
      topLeft: { x: 0.18, y: 0.18 },
      topRight: { x: 0.82, y: 0.18 },
      bottomLeft: { x: 0.18, y: 0.82 },
      bottomRight: { x: 0.82, y: 0.82 },
    },
  };
  const holds = generateTnutGrid({ ...grid, firstRowOffset });
  // CRUX's complementary arrangement keeps the grid but reverses its inset rows.
  const lights = generateTnutGrid({ ...grid, firstRowOffset: !firstRowOffset });
  return (
    <Svg width="100%" height="100%" viewBox="0 0 100 100" accessible={false}>
      <Rect width={100} height={100} rx={8} fill={systemColors.tertiaryGroupedBackground} />
      {holds.map(({ x, y }, index) => (
        <G key={index} transform={`translate(${x * 100 - 12} ${y * 100 - 12}) scale(0.24)`}>
          <Path
            d={holdOutline}
            fill={systemColors.secondaryLabel}
            fillOpacity={0.22}
            stroke={systemColors.secondaryLabel}
            strokeWidth={3}
          />
          <Path d="M31 43C41 34 61 33 70 45" fill="none" stroke={systemColors.secondaryLabel} strokeWidth={3} />
          <Circle cx={50} cy={50} r={3} fill={systemColors.secondaryLabel} />
        </G>
      ))}
      {lights.map(({ x, y }, index) => (
        <G key={index}>
          <Circle cx={x * 100} cy={y * 100} r={6} fill={brandColors.primary} opacity={0.16} />
          <Circle cx={x * 100} cy={y * 100} r={3} fill={brandColors.primary} />
          <Circle cx={x * 100} cy={y * 100} r={1.2} fill={systemColors.tertiaryGroupedBackground} />
        </G>
      ))}
    </Svg>
  );
}
