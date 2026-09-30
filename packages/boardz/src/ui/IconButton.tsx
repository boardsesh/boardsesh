import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Icon, type IconComponent } from './Icon';
import { useTheme } from './theme';
import { radius } from './tokens';

type IconButtonVariant = 'ghost' | 'secondary' | 'tonal' | 'primary';
/** `field` sits next to a 44pt text field; `lg` is 48, `xl` board mode. */
type IconButtonSize = 'sm' | 'md' | 'field' | 'lg' | 'xl';

const SIZES: Record<IconButtonSize, [number, number]> = {
  sm: [32, 16],
  md: [40, 20],
  field: [44, 20],
  lg: [48, 20],
  xl: [56, 22],
};

type IconButtonProps = {
  icon: IconComponent;
  /** Spoken by VoiceOver. Always required. */
  label: string;
  onPress: () => void;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** Fills the glyph in ink. */
  active?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** An icon-only button: back, filters, settings. */
export function IconButton({
  icon,
  label,
  onPress,
  variant = 'ghost',
  size = 'md',
  active = false,
  disabled = false,
  style,
}: IconButtonProps) {
  const theme = useTheme();
  const [box, iconSize] = SIZES[size];
  const primary = variant === 'primary';
  const background = primary ? theme.accent : variant === 'tonal' ? theme.bgSurface3 : 'transparent';
  const foreground = primary ? theme.fgOnAccent : active ? theme.fg1 : theme.fg2;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
      hitSlop={box < 44 ? (44 - box) / 2 : 0}
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        {
          width: box,
          height: box,
          backgroundColor: pressed && !primary ? theme.bgSurface3 : background,
          borderWidth: variant === 'secondary' ? 1 : 0,
          borderColor: theme.border2,
          opacity: disabled ? 0.4 : 1,
          transform: [{ scale: pressed && !disabled ? 0.94 : 1 }],
        },
        style,
      ]}
    >
      <Icon icon={icon} size={iconSize} color={foreground} filled={active} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: radius.md,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
