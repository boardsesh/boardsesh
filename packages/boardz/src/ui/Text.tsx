import type { ReactNode } from 'react';
import { StyleSheet, Text as NativeText, type AccessibilityRole, type StyleProp, type TextStyle } from 'react-native';
import { FONT } from './fonts';
import { useTheme, type Theme } from './theme';

// Graphite type roles (designsystem/tokens/typography.css). Tracking is given
// in em there; React Native wants points, so it's multiplied out here.
const variants = StyleSheet.create({
  /** Page titles: Geist 600, 38, −0.045em. */
  display: { fontFamily: FONT.sansSemiBold, fontSize: 38, lineHeight: 40, letterSpacing: -1.7 },
  title1: { fontFamily: FONT.sansSemiBold, fontSize: 30, lineHeight: 32, letterSpacing: -1.2 },
  title2: { fontFamily: FONT.sansSemiBold, fontSize: 24, lineHeight: 30, letterSpacing: -0.72 },
  title3: { fontFamily: FONT.sansMedium, fontSize: 17, lineHeight: 22, letterSpacing: -0.26 },
  body: { fontFamily: FONT.sans, fontSize: 15, lineHeight: 22 },
  bodyStrong: { fontFamily: FONT.sansMedium, fontSize: 15, lineHeight: 22, letterSpacing: -0.15 },
  small: { fontFamily: FONT.sans, fontSize: 13, lineHeight: 19 },
  caption: { fontFamily: FONT.sans, fontSize: 12, lineHeight: 15 },
  /** Mono uppercase labels: `SENDS`, `MOONBOARD 2024 · 40°`. */
  label: { fontFamily: FONT.mono, fontSize: 10, lineHeight: 12, letterSpacing: 0.8, textTransform: 'uppercase' },
  /** Figures inside text: counts, setters' ascents, dates. */
  mono: { fontFamily: FONT.mono, fontSize: 11, lineHeight: 14 },
  /** Readout strip values. */
  value: { fontFamily: FONT.mono, fontSize: 17, lineHeight: 20, letterSpacing: -0.34 },
  /** Tile values: light mono. */
  figure: { fontFamily: FONT.monoLight, fontSize: 30, lineHeight: 32, letterSpacing: -1.5 },
  /** The big numerals: a grade, a countdown. */
  readout: { fontFamily: FONT.monoLight, fontSize: 64, lineHeight: 70, letterSpacing: -4.4 },
  grade: { fontFamily: FONT.monoMedium, fontSize: 14, lineHeight: 16, letterSpacing: -0.28 },
});

export type TextVariant = keyof typeof variants;
export type TextTone = 'primary' | 'secondary' | 'tertiary' | 'faint' | 'inverse' | 'onAccent' | 'danger' | 'success';

const TONE: Record<TextTone, keyof Theme> = {
  primary: 'fg1',
  secondary: 'fg2',
  tertiary: 'fg3',
  faint: 'fg4',
  inverse: 'fgInverse',
  onAccent: 'fgOnAccent',
  danger: 'danger',
  success: 'success',
};

export type TextProps = {
  children: ReactNode;
  variant?: TextVariant;
  /** Labels default to tertiary, everything else to primary. */
  tone?: TextTone;
  /** Overrides the tone, e.g. for a grade colour. */
  color?: string;
  numberOfLines?: number;
  /** Tabular digits, so a running clock doesn't jitter. */
  monospacedDigits?: boolean;
  align?: TextStyle['textAlign'];
  accessibilityRole?: AccessibilityRole;
  accessibilityLabel?: string;
  style?: StyleProp<TextStyle>;
};

export function Text({
  children,
  variant = 'body',
  tone,
  color,
  numberOfLines,
  monospacedDigits = false,
  align,
  accessibilityRole,
  accessibilityLabel,
  style,
}: TextProps) {
  const theme = useTheme();
  const resolvedTone = tone ?? (variant === 'label' ? 'tertiary' : 'primary');
  return (
    <NativeText
      numberOfLines={numberOfLines}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      style={[
        variants[variant],
        { color: color ?? (theme[TONE[resolvedTone]] as string) },
        monospacedDigits && styles.monospacedDigits,
        align !== undefined && { textAlign: align },
        style,
      ]}
    >
      {children}
    </NativeText>
  );
}

const styles = StyleSheet.create({
  monospacedDigits: { fontVariant: ['tabular-nums'] },
});
