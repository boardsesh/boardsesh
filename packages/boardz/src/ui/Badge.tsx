import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { FONT } from './fonts';
import { LedDot } from './LedDot';
import { Text } from './Text';
import { LED, useTheme, type Theme } from './theme';
import { radius } from './tokens';

type BadgeTone = 'neutral' | 'accent' | 'success' | 'danger' | 'inverse';
type BadgeSize = 'xs' | 'sm' | 'md';

const SIZES: Record<BadgeSize, [number, number, number]> = { xs: [16, 4, 9], sm: [20, 6, 10], md: [24, 8, 12] };
const DOTS: Partial<Record<BadgeTone, string>> = { success: LED.green, danger: LED.red };

function toneColors(tone: BadgeTone, theme: Theme): [string, string, string] {
  switch (tone) {
    case 'neutral':
      return [theme.bgSurface3, theme.fg2, theme.border2];
    case 'accent':
      return [theme.accent, theme.fgOnAccent, theme.fg1];
    case 'success':
      return [theme.successSoft, theme.success, theme.success];
    case 'danger':
      return [theme.dangerSoft, theme.danger, theme.danger];
    case 'inverse':
      return [theme.bgInverse, theme.fgInverse, theme.bgInverse];
  }
}

type BadgeProps = {
  children: ReactNode;
  tone?: BadgeTone;
  size?: BadgeSize;
  /** The house style for metadata: a hairline outline. */
  outline?: boolean;
  /** A glowing LED, for status. */
  dot?: boolean;
  /** Mono uppercase, like `BENCHMARK` or `40°`. */
  mono?: boolean;
};

/** A small label for status and metadata. */
export function Badge({
  children,
  tone = 'neutral',
  size = 'md',
  outline = false,
  dot = false,
  mono = false,
}: BadgeProps) {
  const theme = useTheme();
  const [background, foreground, ring] = toneColors(tone, theme);
  const [height, paddingX, fontSize] = SIZES[size];
  const textSize = mono ? Math.max(9, fontSize - 2) : fontSize;
  return (
    <View
      style={[
        styles.badge,
        {
          height,
          paddingHorizontal: paddingX,
          backgroundColor: outline ? 'transparent' : background,
          borderWidth: outline ? 1 : 0,
          borderColor: ring,
          borderRadius: size === 'xs' ? radius.xs : radius.sm,
        },
      ]}
    >
      {dot ? <LedDot color={DOTS[tone] ?? foreground} size={6} /> : null}
      <Text
        variant={mono ? 'label' : 'caption'}
        color={outline && tone === 'neutral' ? theme.fg2 : foreground}
        numberOfLines={1}
        style={{
          fontSize: textSize,
          lineHeight: textSize + 2,
          fontFamily: mono ? FONT.mono : FONT.sansMedium,
        }}
      >
        {children}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
});
