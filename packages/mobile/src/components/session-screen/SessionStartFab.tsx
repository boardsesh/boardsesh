import { useCallback } from 'react';
import { ActivityIndicator, type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { FAB } from 'react-native-paper';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { iconMap, type IconName } from '../icon-map';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { hapticLight } from '../../lib/haptics';
import { spacing, shadows } from '../../theme/tokens';

const CAPSULE_HEIGHT = 52;
const CAPSULE_RADIUS = CAPSULE_HEIGHT / 2;

/** The Liquid Glass capsule's container height (capsule + its bottom padding). Hosts
 *  seed their reserved bottom inset with this so the first paint matches the measured
 *  `onHeightChange` value instead of a glass-vs-material-agnostic guess. */
export const SESSION_START_FAB_HEIGHT = CAPSULE_HEIGHT + spacing[2];

type SessionStartFabProps = {
  /** Visible label — the Start copy (Material renders it as the extended FAB label;
   *  Liquid Glass as the floating capsule title). */
  label: string;
  /** Icon name — rendered as the SF Symbol on the Liquid Glass capsule and mapped to
   *  its Android glyph for the Material extended FAB. */
  icon: IconName;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
  /** Bottom offset from the screen edge — the host computes the variant-correct value
   *  once (so the FAB and the host's list reservation can't drift) and passes it here. */
  bottomOffset: number;
  /** Fires with the measured action height (excluding the bottom offset) so the host
   *  list reserves `measuredHeight + bottomOffset` and keeps its last row clear. */
  onHeightChange?: (height: number) => void;
};

/**
 * The session Start action, routed by UI variant. It is the screen's single
 * primary action, floated bottom-trailing with the scroll list running under it —
 * not a full-width pinned bar. Liquid Glass renders a brand-tinted **glass**
 * capsule (the iOS 26 `.glassProminent` look: a `GlassSurface` tinted with the
 * brand hue, not a flat opaque fill); Material renders an M3 extended FAB. Both sit
 * over the host-supplied `bottomOffset` (variant-correct: the raw safe-area inset on
 * Liquid Glass — which already includes the tab bar + accessory — or the fixed-footer
 * reserve on Material) and report their height through `onHeightChange`.
 *
 * The End action no longer lives here — it docks in the top chrome (see
 * `RecordTopChrome` / `SessionScreenHeader`).
 */
export function SessionStartFab({
  label,
  icon,
  onPress,
  disabled,
  loading,
  testID,
  bottomOffset,
  onHeightChange,
}: SessionStartFabProps) {
  const { variant } = useTheme();

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onHeightChange?.(event.nativeEvent.layout.height);
    },
    [onHeightChange],
  );

  return (
    <View
      testID={testID}
      pointerEvents="box-none"
      onLayout={onHeightChange ? handleLayout : undefined}
      style={[styles.container, { bottom: bottomOffset }]}
    >
      {selectByVariant(variant, {
        material: (
          <FAB
            icon={iconMap[icon].android}
            label={label}
            onPress={onPress}
            disabled={disabled}
            loading={loading}
            variant="primary"
            mode="elevated"
          />
        ),
        liquidGlass: (
          <StartGlassCapsule label={label} icon={icon} onPress={onPress} disabled={disabled} loading={loading} />
        ),
      })}
    </View>
  );
}

/**
 * The Liquid Glass Start capsule: a brand-tinted glass pill (real iOS 26 glass via
 * `GlassSurface`, with an opaque brand fill on the no-glass fallback) rather than a
 * flat filled button. Off native glass it gets a shadow + hairline so it still
 * reads as a raised control.
 */
function StartGlassCapsule({
  label,
  icon,
  onPress,
  disabled,
  loading,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const { brandColors, systemColors } = useTheme();
  const nativeGlass = useNativeGlass();
  const inactive = disabled || loading;

  const handlePress = useCallback(() => {
    if (inactive) return;
    hapticLight();
    onPress();
  }, [inactive, onPress]);

  return (
    <PressableSurface
      onPress={handlePress}
      feedback="scale"
      scaleTo={0.96}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive }}
      accessibilityLabel={label}
      style={[
        styles.capsule,
        { opacity: disabled ? 0.5 : 1 },
        !nativeGlass && shadows.sm,
        !nativeGlass && { borderWidth: StyleSheet.hairlineWidth, borderColor: systemColors.separator },
      ]}
    >
      <GlassSurface
        glassEffectStyle="regular"
        tintColor={brandColors.primary}
        fallbackColor={brandColors.primaryFill}
        borderRadius={CAPSULE_RADIUS}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {loading ? (
        <ActivityIndicator size="small" color={brandColors.onPrimary} />
      ) : (
        <Icon name={icon} size={18} color={brandColors.onPrimary} />
      )}
      <Text variant="body" color={brandColors.onPrimary} style={styles.capsuleLabel}>
        {label}
      </Text>
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  // Absolute + box-none so the list scrolls under it everywhere except the action
  // itself; bottom-trailing is the reachable one-handed corner for a deliberate commit.
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'flex-end',
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[2],
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[2],
    height: CAPSULE_HEIGHT,
    paddingHorizontal: spacing[5],
    borderRadius: CAPSULE_RADIUS,
    overflow: 'hidden',
  },
  capsuleLabel: {
    fontWeight: '600',
  },
});
