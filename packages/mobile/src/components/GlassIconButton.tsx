import { useCallback, useEffect, useRef } from 'react';
import {
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type ColorValue,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { IconButton as PaperIconButton } from 'react-native-paper';
import { GlassSurface } from './GlassSurface';
import { PressableSurface } from './PressableSurface';
import { Icon } from './Icon';
import { Text } from './Text';
import { iconMap, type IconName } from './icon-map';
import { createVariantComponent } from '../theme/variants';
import { brandColors } from '../theme/colors';
import { iosSystemColors } from '../theme/ios-colors';
import { timing } from '../theme/animations';
import { glassSize } from '../theme/layout';
import { useReduceMotion } from '../hooks/use-reduce-motion';

type GlassIconButtonProps = {
  iconName: IconName;
  iconColor: ColorValue;
  iconSize?: number;
  onPress: () => void;
  onLongPress?: () => void;
  accessibilityLabel: string;
  /** Hint describing what activation does — useful when the button morphs in
   *  place (e.g. search ↔ close) rather than navigating. */
  accessibilityHint?: string;
  /** Custom assistive-tech actions (e.g. a grade shortcut VoiceOver / Switch
   *  Control can reach, mirroring an otherwise-invisible long-press). */
  accessibilityActions?: ReadonlyArray<AccessibilityActionInfo>;
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  /** Translucent tint composited on the glass (iOS). Omit for a neutral surface. */
  tintColor?: string;
  /** Solid colour used on Android, Reduce Transparency, and the cold-start frame. */
  fallbackColor: ColorValue;
  /** Count badge (top-right). Rendered only when > 0. */
  badgeCount?: number;
  /** Optional badge fill override for controls whose main surface already uses the default badge colour. */
  badgeBackgroundColor?: ColorValue;
  /** Optional badge text override paired with `badgeBackgroundColor`. */
  badgeTextColor?: ColorValue;
  disabled?: boolean;
  /** Diameter of the circular target (default `glassSize.standard` — the standard
   *  floating FAB; pass `glassSize.hero` for a surface's defining action). */
  size?: number;
  /**
   * Optional second glyph the button morphs to (e.g. search ↔ close). When set,
   * the two icons cross-fade over `active`; honours Reduce Motion (instant swap).
   */
  secondaryIconName?: IconName;
  /** Drives the morph: false shows `iconName`, true shows `secondaryIconName`. */
  active?: boolean;
};

const MAX_BADGE_COUNT = 99;
const BADGE_MAX_FONT_SIZE_MULTIPLIER = 1;

function formatBadgeCount(badgeCount: number | undefined): string | null {
  if (badgeCount == null || badgeCount <= 0) return null;
  return badgeCount > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(badgeCount);
}

/**
 * Circular icon button shared by the climb-list search row (filter, create) and
 * the bottom-bar search FAB. Routes to a Material 3 `IconButton` on the Material
 * variant and to the original Liquid Glass circle on the Liquid Glass variant.
 * The public prop API is identical for both, so call sites never change.
 */
export const GlassIconButton = createVariantComponent('GlassIconButton', {
  liquidGlass: GlassIconButtonGlass,
  material: GlassIconButtonMaterial,
});

/**
 * Material 3 icon button. Paper resolves the MDI glyph through our icon settings
 * (see material-theme-provider), so we hand it the `.android` MDI name. Paper's
 * `IconButton` renders a single glyph — the Liquid Glass cross-fade morph
 * (`secondaryIconName` / `active`) has no Material equivalent and is dropped
 * here; the static `iconName` is shown instead. The count badge uses the same
 * owned overlay as the Liquid Glass path so clamping and Dynamic Type limits
 * stay identical across variants.
 */
function GlassIconButtonMaterial({
  iconName,
  iconColor,
  iconSize = 22,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityHint,
  accessibilityActions,
  onAccessibilityAction,
  badgeCount,
  badgeBackgroundColor,
  badgeTextColor,
  disabled = false,
  size = glassSize.standard,
}: GlassIconButtonProps) {
  const badgeLabel = formatBadgeCount(badgeCount);

  return (
    <View style={[styles.wrapper, { width: size, height: size }]}>
      <PaperIconButton
        icon={iconMap[iconName].android}
        // Paper types iconColor as `string`. In the Material branch our themed
        // colours resolve from materialSurfaces (hex/rgba strings on every
        // platform), so no PlatformColor opaque ref reaches here; even if one
        // did, Paper forwards it to MaterialCommunityIcons' `color`, which
        // accepts ColorValue at runtime. The cast just satisfies Paper's type.
        iconColor={iconColor as string}
        size={iconSize}
        // Match the circular target diameter; Paper's default margin would
        // otherwise inflate the footprint past the requested `size`.
        style={[styles.materialButton, { width: size, height: size }]}
        onPress={onPress}
        onLongPress={onLongPress}
        disabled={disabled}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={onAccessibilityAction}
      />
      {badgeLabel ? (
        <BadgeLabel
          label={badgeLabel}
          backgroundColor={badgeBackgroundColor}
          textColor={badgeTextColor}
          style={styles.materialBadge}
        />
      ) : null}
    </View>
  );
}

/**
 * Circular Liquid Glass button — the floating-control affordance shared by the
 * climb-list search row (filter, create) and the bottom-bar search FAB. The glass
 * fills a clipped circle so the iOS < 26 blur fallback doesn't spill past the
 * radius; the badge sits in an outer, unclipped wrapper so a round corner can't
 * crop it. Routes through GlassSurface (glass → blur → solid) and PressableSurface
 * (spring / ripple), so Android, Reduce Transparency, and cold-start all degrade
 * correctly. With `secondaryIconName`, the glyph cross-fades on `active`.
 */
function GlassIconButtonGlass({
  iconName,
  iconColor,
  iconSize = 22,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityHint,
  accessibilityActions,
  onAccessibilityAction,
  tintColor,
  fallbackColor,
  badgeCount,
  badgeBackgroundColor,
  badgeTextColor,
  disabled = false,
  size = glassSize.standard,
  secondaryIconName,
  active = false,
}: GlassIconButtonProps) {
  const reduceMotion = useReduceMotion();
  const badgeLabel = formatBadgeCount(badgeCount);
  const suppressPressRef = useRef(false);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 0 → primary glyph, 1 → secondary glyph. Only used when `secondaryIconName` is set.
  const morph = useSharedValue(active ? 1 : 0);
  useEffect(() => {
    const target = active ? 1 : 0;
    morph.value = reduceMotion ? target : withTiming(target, { duration: timing.fast });
  }, [active, reduceMotion, morph]);

  useEffect(
    () => () => {
      if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
    },
    [],
  );

  const primaryIconStyle = useAnimatedStyle(() => ({ opacity: 1 - morph.value }));
  const secondaryIconStyle = useAnimatedStyle(() => ({ opacity: morph.value }));
  const handlePress = useCallback(() => {
    if (suppressPressRef.current) {
      suppressPressRef.current = false;
      if (releaseTimerRef.current) {
        clearTimeout(releaseTimerRef.current);
        releaseTimerRef.current = null;
      }
      return;
    }
    onPress();
  }, [onPress]);
  const handleLongPress = useCallback(() => {
    if (!onLongPress) return;
    suppressPressRef.current = true;
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
    onLongPress();
  }, [onLongPress]);
  const handlePressOut = useCallback(() => {
    if (!suppressPressRef.current) return;
    if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = setTimeout(() => {
      suppressPressRef.current = false;
      releaseTimerRef.current = null;
    }, 0);
  }, []);

  return (
    <View style={[styles.wrapper, { width: size, height: size }]}>
      <PressableSurface
        onPress={handlePress}
        onPressOut={handlePressOut}
        onLongPress={onLongPress ? handleLongPress : undefined}
        disabled={disabled}
        feedback="scale"
        scaleTo={0.92}
        rippleBorderless
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={onAccessibilityAction}
        style={[styles.button, { width: size, height: size, borderRadius: size / 2 }]}
      >
        <GlassSurface
          glassEffectStyle="regular"
          tintColor={tintColor}
          fallbackColor={fallbackColor}
          borderRadius={size / 2}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {secondaryIconName ? (
          <>
            <Animated.View style={[StyleSheet.absoluteFill, styles.center, primaryIconStyle]} pointerEvents="none">
              <Icon name={iconName} size={iconSize} color={iconColor as string} />
            </Animated.View>
            <Animated.View style={[StyleSheet.absoluteFill, styles.center, secondaryIconStyle]} pointerEvents="none">
              <Icon name={secondaryIconName} size={iconSize} color={iconColor as string} />
            </Animated.View>
          </>
        ) : (
          <Icon name={iconName} size={iconSize} color={iconColor as string} />
        )}
      </PressableSurface>

      {badgeLabel ? (
        <BadgeLabel label={badgeLabel} backgroundColor={badgeBackgroundColor} textColor={badgeTextColor} />
      ) : null}
    </View>
  );
}

function BadgeLabel({
  label,
  backgroundColor = brandColors.primary,
  textColor = iosSystemColors.white,
  style,
}: {
  label: string;
  backgroundColor?: ColorValue;
  textColor?: ColorValue;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.badge, style, { backgroundColor }]} pointerEvents="none">
      <Text
        variant="caption2"
        color={textColor}
        maxFontSizeMultiplier={BADGE_MAX_FONT_SIZE_MULTIPLIER}
        style={styles.badgeText}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'relative',
  },
  button: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  materialButton: {
    margin: 0,
  },
  materialBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontWeight: '700',
    fontSize: 10,
    lineHeight: 14,
  },
});
