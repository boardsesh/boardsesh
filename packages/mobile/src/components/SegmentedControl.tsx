import { View, StyleSheet, type ViewStyle, type ColorValue } from 'react-native';
import { SegmentedButtons } from 'react-native-paper';
import { Text } from './Text';
import { PressableSurface } from './PressableSurface';
import { hapticSelection } from '../lib/haptics';
import { spacing } from '../theme/tokens';
import { useTheme } from '../providers/theme-provider';
import { selectByVariant } from '../theme/variants';

type SegmentOption<K extends string> = {
  key: K;
  label: string;
};

type SegmentedControlProps<K extends string> = {
  options: SegmentOption<K>[];
  selectedKey: K;
  onSelect: (key: K) => void;
  /** Text variant for segment labels. Defaults to 'subheadline'. */
  textVariant?: 'subheadline' | 'footnote';
  /** Background color for the segmented control track. */
  trackColor: ColorValue;
  /** Keys that render dimmed and non-selectable (e.g. Liquid Glass on a device that can't show it). */
  disabledKeys?: ReadonlySet<K>;
  /** Accessibility label naming the group (e.g. "Appearance"), so VoiceOver announces what the segments control. */
  accessibilityLabel?: string;
};

function Segment({
  label,
  selected,
  disabled,
  onPress,
  textVariant,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
  textVariant: 'subheadline' | 'footnote';
}) {
  const { systemColors, colorScheme, opacity, brandColors } = useTheme();
  const isDark = colorScheme === 'dark';

  // Selected pill is a raised tile over the track — elevatedSurface reads as a
  // light pill in light mode and a lighter-than-track tile in dark mode.
  const segmentStyle: ViewStyle = {
    flex: 1,
    paddingVertical: spacing[2],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
    ...(disabled && { opacity: opacity.disabled }),
    ...(selected && {
      backgroundColor: systemColors.elevatedSurface,
      // A hairline edge + lift so the thumb reads clearly even over a translucent
      // glass track in dark mode, where the fill-vs-thumb luminance delta is small.
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: systemColors.separator,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.2,
      shadowRadius: 3,
      elevation: 3,
    }),
  };

  // Violet brand accent reads well on the light pill (#6D28D9 on white = 7.10:1);
  // on the dark pill it's too low-contrast, so fall back to the high-contrast
  // label colour there.
  const selectedTextColor = isDark ? systemColors.label : brandColors.primary;

  return (
    <PressableSurface
      onPress={() => {
        if (disabled) return;
        hapticSelection();
        onPress();
      }}
      disabled={disabled}
      feedback="scale"
      scaleTo={0.95}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={label}
      style={segmentStyle}
    >
      <Text
        variant={textVariant}
        color={selected ? selectedTextColor : undefined}
        style={selected ? styles.labelSelected : styles.label}
      >
        {label}
      </Text>
    </PressableSurface>
  );
}

/**
 * SegmentedControl routes to a Material 3 `SegmentedButtons` on the Material
 * variant, and to the existing Liquid-Glass/HIG segmented control on the Liquid
 * Glass variant. The public prop API is identical for both, so call sites never
 * change.
 */
export function SegmentedControl<K extends string = string>(props: SegmentedControlProps<K>) {
  // Generic over the option key, so it stays an explicit wrapper (the variant factory
  // fixes the prop type); selectByVariant keeps the swap declarative — no raw
  // `variant ===` — and renders the chosen impl as JSX (its own fiber/hooks).
  const Impl = selectByVariant(useTheme().variant, {
    liquidGlass: SegmentedControlGlass,
    material: SegmentedControlMaterial,
  });
  return <Impl {...props} />;
}

function SegmentedControlMaterial<K extends string = string>({
  options,
  selectedKey,
  onSelect,
  disabledKeys,
  accessibilityLabel,
}: SegmentedControlProps<K>) {
  const buttons = options.map((option) => ({
    value: option.key,
    label: option.label,
    disabled: disabledKeys?.has(option.key) ?? false,
  }));

  // Paper never fires onValueChange for a button rendered disabled, so disabled
  // keys can't reach here — no re-check needed.
  const handleValueChange = (nextKey: K) => {
    hapticSelection();
    onSelect(nextKey);
  };

  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel}>
      <SegmentedButtons value={selectedKey} onValueChange={handleValueChange} buttons={buttons} />
    </View>
  );
}

// Liquid Glass / HIG segmented control — the original implementation, unchanged.
function SegmentedControlGlass<K extends string = string>({
  options,
  selectedKey,
  onSelect,
  textVariant = 'subheadline',
  trackColor,
  disabledKeys,
  accessibilityLabel,
}: SegmentedControlProps<K>) {
  const containerStyle = {
    flexDirection: 'row' as const,
    backgroundColor: trackColor,
    borderRadius: 9,
    padding: 2,
  };

  return (
    <View style={containerStyle} accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel}>
      {options.map((option) => (
        <Segment
          key={option.key}
          label={option.label}
          selected={selectedKey === option.key}
          disabled={disabledKeys?.has(option.key) ?? false}
          onPress={() => onSelect(option.key)}
          textVariant={textVariant}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    fontWeight: '500',
  },
  labelSelected: {
    fontWeight: '600',
  },
});
