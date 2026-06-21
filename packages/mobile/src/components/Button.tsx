import { StyleSheet, type ViewStyle } from 'react-native';
import { Button as PaperButton } from 'react-native-paper';
import { Text } from './Text';
import { Icon } from './Icon';
import { PressableSurface } from './PressableSurface';
import { iconMap, type IconName } from './icon-map';
import { hapticLight } from '../lib/haptics';
import { useTheme } from '../providers/theme-provider';
import { createVariantComponent } from '../theme/variants';

type ButtonVariant = 'filled' | 'outlined' | 'text' | 'tonal';
type ButtonSize = 'small' | 'medium' | 'large';

type ButtonProps = {
  title: string;
  onPress: () => void;
  accessibilityLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  haptic?: boolean;
  tintColor?: string;
  /** Native test identifier (used by Maestro screenshot flows). */
  testID?: string;
  style?: ViewStyle;
};

const sizeConfig = {
  small: { paddingHorizontal: 12, paddingVertical: 6, fontSize: 14, iconSize: 16 },
  medium: { paddingHorizontal: 16, paddingVertical: 10, fontSize: 16, iconSize: 20 },
  large: { paddingHorizontal: 20, paddingVertical: 14, fontSize: 17, iconSize: 22 },
} as const;

/**
 * Button routes to an authentic Material 3 button on the Material variant, and to
 * the existing Liquid-Glass/HIG button on the Liquid Glass variant. The public
 * prop API is identical for both, so call sites never change.
 */
export const Button = createVariantComponent('Button', { liquidGlass: ButtonGlass, material: ButtonMaterial });

// 'tonal' is the M3 middle-emphasis button — Paper's contained-tonal pulls its
// secondaryContainer fill + onSecondaryContainer label straight from the MD3
// theme, so it needs no buttonColor/textColor override below.
const PAPER_MODE = { filled: 'contained', outlined: 'outlined', text: 'text', tonal: 'contained-tonal' } as const;

function ButtonMaterial({
  title,
  onPress,
  accessibilityLabel,
  variant = 'filled',
  size = 'medium',
  icon,
  disabled = false,
  loading = false,
  haptic = true,
  tintColor,
  testID,
  style,
}: ButtonProps) {
  const { brandColors: brand } = useTheme();
  // Filled buttons sit on a brand FILL; outlined/text use the legible brand TINT.
  const fillColor = tintColor ?? brand.primaryFill;
  const accentColor = tintColor ?? brand.primary;
  const config = sizeConfig[size];
  const handlePress = () => {
    if (disabled || loading) return;
    if (haptic) hapticLight();
    onPress();
  };

  return (
    <PaperButton
      mode={PAPER_MODE[variant]}
      onPress={handlePress}
      disabled={disabled || loading}
      loading={loading}
      // Paper resolves the MDI glyph through our icon settings (see
      // material-theme-provider); map our semantic name to its MDI name.
      icon={icon ? iconMap[icon].android : undefined}
      buttonColor={variant === 'filled' ? fillColor : undefined}
      // Tonal lets Paper use its onSecondaryContainer label; only outlined/text
      // take the brand tint.
      textColor={variant === 'filled' || variant === 'tonal' ? undefined : accentColor}
      accessibilityLabel={accessibilityLabel ?? title}
      // Approximate the small/medium/large ladder on Paper's single-height button.
      labelStyle={{ fontSize: config.fontSize }}
      contentStyle={{ paddingVertical: config.paddingVertical }}
      testID={testID}
      style={style}
    >
      {title}
    </PaperButton>
  );
}

// Liquid Glass / HIG button — the original implementation, unchanged.
function ButtonGlass({
  title,
  onPress,
  accessibilityLabel,
  variant = 'filled',
  size = 'medium',
  icon,
  disabled = false,
  loading = false,
  haptic = true,
  tintColor,
  testID,
  style,
}: ButtonProps) {
  const config = sizeConfig[size];
  // Soft 10dp corner on Liquid Glass; brand colours resolve per colour scheme.
  const { radii, brandColors: brand } = useTheme();
  // Filled buttons sit on a brand FILL with on-primary text; outlined/text use the
  // legible brand TINT for both border and label.
  const fillColor = tintColor ?? brand.primaryFill;
  const accentColor = tintColor ?? brand.primary;
  const onFillColor = brand.onPrimary;

  const handlePress = () => {
    if (disabled || loading) return;
    if (haptic) hapticLight();
    onPress();
  };

  const containerStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: config.paddingHorizontal,
    paddingVertical: config.paddingVertical,
    borderRadius: radii.button,
    opacity: disabled ? 0.5 : 1,
    ...(variant === 'filled' && { backgroundColor: fillColor }),
    // HIG has no tonal idiom — the Liquid Glass "Following" state is an outlined
    // capsule, so tonal falls back to the same bordered treatment here.
    ...((variant === 'outlined' || variant === 'tonal') && { borderWidth: 1, borderColor: accentColor }),
  };

  const textColor = variant === 'filled' ? onFillColor : accentColor;
  // M3 ripple: on-primary over a filled button, the tint over outlined/text.
  const rippleColor = variant === 'filled' ? onFillColor : accentColor;

  return (
    <PressableSurface
      onPress={handlePress}
      feedback="scale"
      scaleTo={0.96}
      rippleColor={rippleColor}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading }}
      accessibilityLabel={accessibilityLabel ?? title}
      testID={testID}
      style={[containerStyle, style]}
    >
      {icon && <Icon name={icon} size={config.iconSize} color={textColor} />}
      <Text
        variant={size === 'small' ? 'footnote' : size === 'large' ? 'body' : 'callout'}
        color={textColor}
        style={styles.label}
      >
        {loading ? '...' : title}
      </Text>
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  label: { fontWeight: '600' },
});
