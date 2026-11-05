import { useId } from 'react';
import Svg, {
  Circle,
  ClipPath,
  Defs,
  Ellipse,
  G,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';
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
  if (placement === 'sides') return <BehindHoldThumbnail />;
  const lights = placement === 'below' ? [[50, 82]] : [[50, 50]];
  return (
    <Svg width="100%" height="100%" viewBox="0 0 100 100" accessible={false}>
      <Rect width={100} height={100} rx={8} fill={systemColors.tertiaryGroupedBackground} />
      <Path
        d={holdOutline}
        fill={systemColors.secondaryLabel}
        fillOpacity={0.22}
        stroke={systemColors.secondaryLabel}
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

// Selected diagram: two lights behind the translucent sides, with a solid grip centre.
const behindHoldOutline =
  'M49 162C46 132 66 104 92 88C114 72 143 75 163 80C188 81 216 96 237 120C254 139 262 163 247 183C230 208 199 222 166 224C135 230 98 223 76 209C60 198 51 183 49 162Z';

function BehindHoldThumbnail() {
  const { systemColors, brandColors } = useTheme();
  const idPrefix = `led-behind-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const clipId = `${idPrefix}-clip`;
  const materialId = `${idPrefix}-material`;
  const lightId = `${idPrefix}-light`;
  return (
    <Svg width="100%" height="100%" viewBox="0 0 300 300" accessible={false}>
      <Rect width={300} height={300} rx={24} fill={systemColors.tertiaryGroupedBackground} />
      <Defs>
        <ClipPath id={clipId}>
          <Path d={behindHoldOutline} />
        </ClipPath>
        <LinearGradient id={materialId} x1="0%" y1="0%" x2="100%" y2="0%">
          <Stop offset="0%" stopColor={brandColors.primary} stopOpacity={0.12} />
          <Stop offset="23%" stopColor={brandColors.primary} stopOpacity={0.16} />
          <Stop offset="43%" stopColor={systemColors.tertiaryLabel} stopOpacity={0.6} />
          <Stop offset="57%" stopColor={systemColors.tertiaryLabel} stopOpacity={0.6} />
          <Stop offset="78%" stopColor={brandColors.primary} stopOpacity={0.16} />
          <Stop offset="100%" stopColor={brandColors.primary} stopOpacity={0.12} />
        </LinearGradient>
        <RadialGradient id={lightId}>
          <Stop offset="0%" stopColor={brandColors.onPrimary} />
          <Stop offset="12%" stopColor={brandColors.onPrimary} stopOpacity={0.95} />
          <Stop offset="35%" stopColor={brandColors.primary} stopOpacity={0.9} />
          <Stop offset="70%" stopColor={brandColors.primary} stopOpacity={0.4} />
          <Stop offset="100%" stopColor={brandColors.primary} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <G clipPath={`url(#${clipId})`}>
        {[92, 208].map((x) => (
          <G key={x}>
            <Circle cx={x} cy={160} r={32} fill={`url(#${lightId})`} />
            <Rect
              x={x - 5}
              y={155}
              width={10}
              height={10}
              rx={3}
              fill={brandColors.onPrimary}
              stroke={brandColors.primary}
              strokeWidth={1}
            />
          </G>
        ))}
      </G>
      <Path d={behindHoldOutline} fill={`url(#${materialId})`} stroke={systemColors.secondaryLabel} strokeWidth={2} />
      <Path
        d="M77 126C107 101 163 89 209 119"
        fill="none"
        stroke={systemColors.secondaryLabel}
        strokeWidth={4}
        strokeLinecap="round"
        opacity={0.5}
      />
      <Ellipse cx={150} cy={162} rx={13} ry={12} fill={systemColors.secondaryLabel} opacity={0.3} />
      <Circle
        cx={150}
        cy={159}
        r={9}
        fill={systemColors.tertiaryGroupedBackground}
        stroke={systemColors.secondaryLabel}
        strokeWidth={1.7}
      />
      <Circle cx={150} cy={159} r={4.7} fill={systemColors.secondaryLabel} />
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
