import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { FONT } from './fonts';
import { Icon, type IconComponent } from './Icon';
import { LedDot } from './LedDot';
import { Text } from './Text';
import { LED, useTheme, type Theme } from './theme';
import { radius } from './tokens';

/** One `primary` per view. `secondary` is a hairline outline, `tonal` a quiet fill. */
export type ButtonVariant = 'primary' | 'secondary' | 'tonal' | 'ghost' | 'danger';
/** `xl` is board mode: big, for chalky fingers. */
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

type ButtonProps = {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconComponent;
  iconRight?: IconComponent;
  /** A glowing LED in place of the icon. Reserved for lighting the board. */
  led?: boolean | string;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
};

const SIZES: Record<ButtonSize, { height: number; paddingX: number; fontSize: number; iconSize: number }> = {
  sm: { height: 32, paddingX: 12, fontSize: 13, iconSize: 16 },
  md: { height: 40, paddingX: 16, fontSize: 14, iconSize: 18 },
  lg: { height: 48, paddingX: 20, fontSize: 15, iconSize: 19 },
  xl: { height: 56, paddingX: 24, fontSize: 16, iconSize: 20 },
};

function colors(variant: ButtonVariant, theme: Theme) {
  switch (variant) {
    case 'primary':
      return { background: theme.primary, foreground: theme.onPrimary, ring: null };
    case 'secondary':
      return { background: 'transparent', foreground: theme.fg1, ring: theme.border2 };
    case 'tonal':
      return { background: theme.bgSurface3, foreground: theme.fg1, ring: null };
    case 'ghost':
      return { background: 'transparent', foreground: theme.fg1, ring: null };
    case 'danger':
      return { background: 'transparent', foreground: theme.danger, ring: theme.danger };
  }
}

export function Button({
  title,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  led,
  loading = false,
  disabled = false,
  fullWidth = false,
  accessibilityHint,
  style,
}: ButtonProps) {
  const theme = useTheme();
  const inactive = disabled || loading;
  const { height, paddingX, fontSize, iconSize } = SIZES[size];
  const { background, foreground, ring } = colors(variant, theme);
  // On the blue primary a blue LED would vanish, so it glows white there.
  const ledColor = led === true ? (variant === 'primary' ? theme.onPrimary : LED.blue) : led || null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [
        styles.base,
        {
          height,
          paddingHorizontal: paddingX,
          backgroundColor: pressed && variant !== 'primary' ? theme.bgSurface3 : background,
          borderWidth: ring ? 1 : 0,
          borderColor: ring ?? undefined,
          opacity: disabled ? 0.4 : pressed && variant === 'primary' ? 0.85 : 1,
          transform: [{ scale: pressed && !inactive ? 0.98 : 1 }],
        },
        fullWidth && styles.fullWidth,
        style,
      ]}
    >
      <View style={[styles.content, { gap: ledColor ? 10 : 8 }]}>
        {loading ? (
          <ActivityIndicator size="small" color={foreground} />
        ) : ledColor ? (
          <LedDot color={ledColor} size={8} />
        ) : icon ? (
          <Icon icon={icon} size={iconSize} color={foreground} />
        ) : null}
        <Text
          variant="body"
          color={foreground}
          numberOfLines={1}
          style={{
            fontFamily: variant === 'primary' ? FONT.sansSemiBold : FONT.sansMedium,
            fontSize,
            lineHeight: fontSize + 4,
            letterSpacing: -0.15,
          }}
        >
          {title}
        </Text>
        {iconRight ? <Icon icon={iconRight} size={iconSize} color={foreground} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  fullWidth: { alignSelf: 'stretch' },
  content: { flexDirection: 'row', alignItems: 'center' },
});
