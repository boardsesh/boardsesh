import { View, StyleSheet } from 'react-native';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { type IconName } from '../icon-map';
import { CountUpNumber } from './CountUpNumber';
import { spacing, borderRadius, opacity } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useVariantValue } from '../../theme/variants';
import { withAlpha } from '../../theme/colors';

const MATERIAL = { material: true, liquidGlass: false } as const;

export type GlanceDelta = {
  kind: 'up' | 'down' | 'same';
  label: string;
};

type GlanceTileProps = {
  glyph: IconName;
  glyphColor: string;
  /** Numeric headline — counts up on mount. */
  value: number;
  /** Colour for the headline numeral (defaults to the label text colour). */
  valueColor?: string;
  /** Short caption under the value (e.g. "week streak"). */
  label: string;
  /** Optional second line (e.g. "best 15", "hardest V8"). */
  sublabel?: string;
  delta?: GlanceDelta;
  /** Trailing 6-point sparkline (oldest→newest). Rendered as mini bars. */
  sparkline?: number[];
  accessibilityLabel: string;
};

/**
 * One pride tile in the 2×2 glance grid. Neutral tonal surface (the grade hue
 * lives only on the leading glyph) so four tiles read as a calm family, not four
 * saturated alert blocks — matching how the superseded summary tiles handled the
 * Material/Glass split.
 */
export function GlanceTile({
  glyph,
  glyphColor,
  value,
  valueColor,
  label,
  sublabel,
  delta,
  sparkline,
  accessibilityLabel,
}: GlanceTileProps) {
  const { systemColors, m3, brandColors } = useTheme();
  const isMaterial = useVariantValue(MATERIAL);

  const tileColor = isMaterial ? m3.surfaceVariant : systemColors.fill;
  const tileBorder = isMaterial ? m3.outlineVariant : systemColors.separator;
  const labelColor = isMaterial ? m3.onSurfaceVariant : systemColors.secondaryLabel;
  const headlineColor = valueColor ?? (isMaterial ? m3.onSurface : systemColors.label);
  const sublabelColor = isMaterial ? m3.onSurfaceVariant : systemColors.tertiaryLabel;

  // Delta chip draws from plain-hex brand tokens only (it tints itself via
  // withAlpha, which can't take a PlatformColor): up = success, down = warning,
  // even = brand.
  const deltaColor =
    delta?.kind === 'up' ? brandColors.success : delta?.kind === 'down' ? brandColors.warning : brandColors.primary;

  return (
    <View
      style={[styles.tile, { backgroundColor: tileColor, borderColor: tileBorder }]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel}
    >
      <View style={styles.topRow}>
        <Icon name={glyph} size={16} color={glyphColor} />
        {delta ? (
          <View style={[styles.deltaChip, { backgroundColor: withAlpha(deltaColor, isMaterial ? 0.16 : 0.14) }]}>
            <Text variant="caption2" color={deltaColor}>
              {delta.label}
            </Text>
          </View>
        ) : null}
      </View>

      {/* The tile is one a11y element (accessible above), so the numeral's own
          label would be ignored — leave it off rather than duplicate the value. */}
      <CountUpNumber value={value} variant="title1" color={headlineColor} />

      <Text variant="caption1" color={labelColor} numberOfLines={1}>
        {label}
      </Text>
      {sublabel ? (
        <Text variant="caption2" color={sublabelColor} numberOfLines={1} style={styles.sublabel}>
          {sublabel}
        </Text>
      ) : null}

      {sparkline && sparkline.length > 0 ? <Sparkline values={sparkline} color={glyphColor} /> : null}
    </View>
  );
}

const SPARK_MAX_HEIGHT = 18;

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const max = Math.max(1, ...values);
  return (
    <View style={styles.sparkline} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {values.map((value, index) => (
        <View
          key={index}
          style={[
            styles.sparkBar,
            {
              height: Math.max(2, (value / max) * SPARK_MAX_HEIGHT),
              backgroundColor: withAlpha(color, index === values.length - 1 ? 0.9 : 0.4),
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing[3],
    gap: spacing[1],
    minHeight: 96,
    justifyContent: 'center',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 20,
  },
  deltaChip: {
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
  },
  sublabel: {
    opacity: opacity.subtle,
  },
  sparkline: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 3,
    height: SPARK_MAX_HEIGHT,
    marginTop: spacing[1],
  },
  sparkBar: {
    flex: 1,
    borderRadius: 2,
  },
});
