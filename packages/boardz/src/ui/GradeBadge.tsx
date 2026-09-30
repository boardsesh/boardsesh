import { StyleSheet, View } from 'react-native';
import { bandColor, type GradeBand } from '../grades/grades';
import { withAlpha } from './color';
import { FONT } from './fonts';
import { Text } from './Text';
import { useTheme } from './theme';
import { radius } from './tokens';

type GradeBadgeSize = 'sm' | 'md' | 'lg' | 'xl';

/** [height, minWidth, fontSize, radius] per size. */
const TAG: Record<GradeBadgeSize, [number, number, number, number]> = {
  sm: [26, 40, 12, 7],
  md: [30, 50, 14, radius.tag],
  lg: [40, 64, 18, radius.md],
  xl: [56, 88, 24, 12],
};
const DISPLAY_SIZE: Record<GradeBadgeSize, number> = { sm: 32, md: 44, lg: 64, xl: 88 };
/** Wide enough for the longest tag, "BM 8C+", so a column of tags lines up. */
const FIXED_WIDTH: Record<GradeBadgeSize, number> = { sm: 56, md: 64, lg: 76, xl: 96 };

type GradeBadgeProps = {
  label: string | null;
  band: GradeBand;
  /** A benchmark climb: a small "BM" leads the grade inside the tag. */
  benchmark?: boolean;
  /** Every tag the same width, for lists where they stack in a column. */
  fixedWidth?: boolean;
  /** Solid in the band's colour by default; outline for a quieter tag; display for the big readout. */
  variant?: 'outline' | 'solid' | 'display';
  size?: GradeBadgeSize;
};

/** The grade in mono, coloured by its difficulty band. */
export function GradeBadge({
  label,
  band,
  benchmark = false,
  fixedWidth = false,
  variant = 'solid',
  size = 'md',
}: GradeBadgeProps) {
  const theme = useTheme();
  const color = bandColor(theme.grades, band);
  const text = label ?? '?';
  const spoken = label ? `Grade ${label}` : 'Not graded yet';

  if (variant === 'display') {
    const fontSize = DISPLAY_SIZE[size];
    return (
      <Text
        variant="readout"
        color={color ?? theme.fg1}
        numberOfLines={1}
        accessibilityLabel={spoken}
        // A line shorter than the glyphs clips their tops on iOS.
        style={{ fontSize, lineHeight: Math.round(fontSize * 1.1), letterSpacing: -fontSize * 0.07 }}
      >
        {text}
      </Text>
    );
  }

  const [height, minWidth, fontSize, cornerRadius] = TAG[size];
  const solid = variant === 'solid';
  const background = solid ? (color ?? theme.accent) : color ? withAlpha(color, 0.09) : 'transparent';
  const foreground = solid ? (color ? theme.gradeOn : theme.fgOnAccent) : (color ?? theme.fg1);
  return (
    <View
      accessible
      accessibilityLabel={benchmark ? `Benchmark, ${spoken.toLowerCase()}` : spoken}
      style={[
        styles.tag,
        {
          height,
          ...(fixedWidth ? { width: FIXED_WIDTH[size] } : { minWidth }),
          borderRadius: cornerRadius,
          backgroundColor: background,
          borderWidth: solid ? 0 : 1,
          borderColor: color ? withAlpha(color, 0.5) : theme.borderStrong,
        },
      ]}
    >
      <Text
        variant="grade"
        color={foreground}
        numberOfLines={1}
        style={{ fontSize, lineHeight: fontSize + 2, fontFamily: FONT.monoMedium }}
      >
        {benchmark ? (
          <Text
            color={withAlpha(foreground, 0.75)}
            style={[styles.benchmark, { fontSize: Math.round(fontSize * 0.72) }]}
          >
            BM{' '}
          </Text>
        ) : null}
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: { paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  benchmark: { fontFamily: FONT.mono, letterSpacing: 0.4 },
});
