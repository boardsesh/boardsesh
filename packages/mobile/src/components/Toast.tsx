import { useEffect, useRef } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { Snackbar } from 'react-native-paper';
import { useSegments } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './Text';
import { Icon } from './Icon';
import type { IconName } from './icon-map';
import { blendOpaque, withAlpha } from '../theme/colors';
import { borderRadius, spacing } from '../theme/tokens';
import {
  MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT,
  MATERIAL_TAB_BAR_HEIGHT,
  TAB_BAR_HEIGHT,
  TOOLBAR_RESERVE,
} from '../theme/layout';
import type { UiVariant } from '../theme/resolve-ui-variant';
import { isTabsRoute } from '../lib/route-segments';
import { useTheme } from '../providers/theme-provider';
import { createVariantComponent, selectByVariant } from '../theme/variants';

export type ToastVariant = 'success' | 'error' | 'info' | 'warning';

export type ToastData = {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
};

type ToastProps = {
  toast: ToastData;
  onDismiss: (id: string) => void;
};

// The icon glyph is static, but the colour must be scheme-aware: the `colorKey`
// names a `brandColors` field resolved from `useTheme()` at render so dark mode
// lifts to the brighter brand tones.
const VARIANT_CONFIG: Record<ToastVariant, { icon: IconName; colorKey: 'success' | 'error' | 'primary' | 'warning' }> =
  {
    success: { icon: 'success', colorKey: 'success' },
    error: { icon: 'error', colorKey: 'error' },
    info: { icon: 'info', colorKey: 'primary' },
    warning: { icon: 'warning', colorKey: 'warning' },
  };

/**
 * Toast routes to a Material 3 Paper Snackbar on the Material variant, and to the
 * existing Liquid-Glass/HIG pill on the Liquid Glass variant. The public prop API
 * is identical for both, so ToastProvider never changes.
 */
export const Toast = createVariantComponent('Toast', { liquidGlass: ToastGlass, material: ToastMaterial });

/**
 * Reserve the worst-case queue toolbar height on tab screens so a toast never
 * covers the current-climb controls; off tab screens it sits just above the safe
 * area. Shared by both variants — ToastProvider sits above QueueProvider, so this
 * must stay independent from queue context.
 */
function useToastBottomOffset(uiVariant: UiVariant) {
  const insets = useSafeAreaInsets();
  const segments = useSegments();
  const toolbarReserve = selectByVariant(uiVariant, {
    material: MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT,
    liquidGlass: TOOLBAR_RESERVE,
  });
  // The Material variant's JS nav bar is the taller M3 80dp bar; Liquid Glass uses
  // the 49pt iOS tab bar. This is an independent recomputation (it sits above
  // QueueProvider, so it can't use computeBottomChromeMetrics) — keep the tab-bar
  // term variant-aware to match, or the Material snackbar tucks under the nav bar.
  const tabBarHeight = selectByVariant(uiVariant, { material: MATERIAL_TAB_BAR_HEIGHT, liquidGlass: TAB_BAR_HEIGHT });
  return isTabsRoute(segments)
    ? insets.bottom + tabBarHeight + toolbarReserve + spacing[2]
    : insets.bottom + spacing[3];
}

function ToastMaterial({ toast, onDismiss }: ToastProps) {
  const { systemColors, colorScheme, brandColors, variant: uiVariant } = useTheme();
  const bottomOffset = useToastBottomOffset(uiVariant);
  const config = VARIANT_CONFIG[toast.variant];
  const variantColor = brandColors[config.colorKey];

  // Paper drives its own auto-dismiss timer off `duration` + `onDismiss`, so we
  // don't run a manual setTimeout on the Material path (it would double-fire).
  // The glass toast has no tappable affordance, so we omit Paper's trailing
  // icon-dismiss button to keep the same auto-dismiss-only interaction. Paper's
  // wrapper is pointerEvents="box-none", so taps outside the pill reach content
  // behind it — matching the glass path's absoluteFill/box-none wrapper.
  const wrapperStyle: ViewStyle = { bottom: bottomOffset };

  // Carry the same variant cue as the glass pill: an opaque brand-hued wash over
  // the surface (legible while floating over content) plus a leading icon and
  // brand-coloured label. Passing our own content node lets us own the icon and
  // text colour rather than inheriting Paper's inverse-surface text colour.
  // `secondaryBackground as string`: on the Material path themed colours resolve
  // from materialSurfaces (hex strings on every platform), never a PlatformColor
  // opaque ref; blendOpaque also returns its background unchanged for non-hex
  // input, so the cast is safe.
  const backgroundColor = blendOpaque(
    variantColor,
    systemColors.secondaryBackground as string,
    colorScheme === 'dark' ? 0.24 : 0.15,
  );

  return (
    <Snackbar
      visible
      onDismiss={() => onDismiss(toast.id)}
      duration={toast.duration}
      wrapperStyle={wrapperStyle}
      style={{ backgroundColor }}
    >
      {/* role + assertive live region sit on our content node, not the Snackbar
          root (Paper owns that and sets its own polite region). The glass path
          puts them on its container; here the content View is the equivalent
          announced node, so TalkBack reads the message assertively either way. */}
      <View style={styles.materialContent} accessibilityRole="alert" accessibilityLiveRegion="assertive">
        <Icon name={config.icon} size={18} color={variantColor} />
        <Text variant="subheadline" color={variantColor} style={styles.message} numberOfLines={2}>
          {toast.message}
        </Text>
      </View>
    </Snackbar>
  );
}

// Liquid Glass / HIG toast — the original implementation, unchanged.
function ToastGlass({ toast, onDismiss }: ToastProps) {
  const { systemColors, colorScheme, brandColors, variant: uiVariant } = useTheme();
  const bottomOffset = useToastBottomOffset(uiVariant);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const config = VARIANT_CONFIG[toast.variant];
  const variantColor = brandColors[config.colorKey];

  useEffect(() => {
    timerRef.current = setTimeout(() => onDismiss(toast.id), toast.duration);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.id, toast.duration, onDismiss]);

  // Opaque themed pill keeps the toast legible over any content; the brand-hued
  // wash on top carries the variant cue. Bump the wash alpha in dark mode where
  // a 15% tint barely registers.
  const tintColor = withAlpha(variantColor, colorScheme === 'dark' ? 0.24 : 0.15);

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      exiting={FadeOut.duration(200)}
      style={[
        styles.container,
        {
          bottom: bottomOffset,
          backgroundColor: systemColors.secondaryBackground,
        },
      ]}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
    >
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tintColor }]} />
      <Icon name={config.icon} size={18} color={variantColor} />
      <Text variant="subheadline" color={variantColor} style={styles.message} numberOfLines={2}>
        {toast.message}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    borderRadius: borderRadius.full,
    overflow: 'hidden',
    zIndex: 9999,
  },
  message: {
    flexShrink: 1,
  },
  materialContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
});
