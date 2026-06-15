import { type ReactNode, useCallback, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import Animated, {
  type SharedValue,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../providers/theme-provider';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { spacing, shadows } from '../../theme/tokens';
import { Text } from '../Text';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { TOP_ACTION_SIZE } from './GlassActionToolbar';

const ROW_GUTTER = spacing[4];
const TITLE_PILL_HEIGHT = 34;
const TITLE_PILL_RADIUS = TITLE_PILL_HEIGHT / 2;
// The large in-body title collapses into the header over this scroll distance:
// the centred content fades out as the title capsule takes over.
export const COLLAPSE_START = 6;
export const COLLAPSE_END = 48;

// The scrim fades the screen background to clear behind the floating islands, so
// it must match the colour the screen content actually sits on: the React
// Navigation scene background (app/_layout.tsx `ThemedNavigation`) — DefaultTheme
// grey #F2F2F2 in light, `iosDarkColors.background` #000000 in dark. Using white
// here (as `systemColors.background` resolves to) painted a white block over the
// grey scene — a visible band wherever empty scene shows below the islands (the
// Record tab). These are explicit hex, not `systemColors.background`'s
// PlatformColor, for two reasons: (1) the scene background is the nav theme's, not
// systemBackground; (2) expo-linear-gradient resolves a PlatformColor only once and
// never re-resolves it on an in-app light↔dark toggle, so a PlatformColor scrim got
// stuck light-mode-coloured over the now-dark page (the Climbs white band). Keying
// off the resolved colorScheme makes the gradient prop change so the native view repaints.
const SCRIM_BACKGROUND = { light: '#F2F2F2', dark: '#000000' } as const;

/**
 * Shared collapse math for the floating large-title chrome. Returns the 0→1
 * `progress` derived value plus a `collapsed` boolean that flips once past the
 * midpoint (so the faded-out centre content stops capturing touches). Both this
 * board-agnostic header and the board-aware `CollapsingTopChrome` (which docks a
 * board glyph) read from the same math so the title capsule and the board dock
 * stay in lockstep.
 */
export function useCollapseProgress(scrollY: SharedValue<number>) {
  const [collapsed, setCollapsed] = useState(false);
  const progress = useDerivedValue(() =>
    interpolate(scrollY.value, [COLLAPSE_START, COLLAPSE_END], [0, 1], Extrapolation.CLAMP),
  );
  useAnimatedReaction(
    () => progress.value > 0.5,
    (isPast, wasPast) => {
      if (isPast !== wasPast) runOnJS(setCollapsed)(isPast);
    },
  );
  return { progress, collapsed };
}

type CollapsingLargeTitleHeaderProps = {
  /** The screen's identity, shown in the centred collapsed capsule. Callers render
   *  the matching large in-body title at the top of their scroll content. */
  title: string;
  /** VoiceOver label for the collapsed title capsule. Defaults to `title`. */
  titleAccessibilityLabel?: string;
  /** List scroll offset, driving the title collapse. */
  scrollY: SharedValue<number>;
  /** Tapping the collapsed title capsule scrolls the list back to the top. */
  onPressTitle: () => void;
  /** Report the measured chrome height so the list can inset its top padding. */
  onHeightChange: (height: number) => void;
  /** Glass island(s) anchored to the left of the islands row. */
  leftActions?: ReactNode;
  /** Glass island(s) anchored to the right of the islands row. */
  rightActions?: ReactNode;
  /** At-rest centred control (e.g. a board pill) that fades out as the collapsed
   *  title capsule takes over. Omit on screens with no centred control. */
  centerContent?: ReactNode;
  /** Extra controls rendered below the islands row (e.g. a search or segmented
   *  control row). Measured into the reported chrome height. */
  children?: ReactNode;
};

/**
 * The board-agnostic floating glass chrome shared across tabs: a fade scrim, a
 * left/right glass-island row, and the screen's large in-body title collapsing
 * into a centred glass capsule on scroll. The capsule animates with transform
 * only (never opacity) so the live iOS liquid glass never flattens; only the
 * leaving centre content fades. Callers inject their own islands and, optionally,
 * a centred control.
 *
 * The board-aware Discover/Climbs chrome (`CollapsingTopChrome`) composes this
 * and adds the board pill plus the board-glyph dock; the Record and Profile tabs
 * use it with their own islands.
 */
export function CollapsingLargeTitleHeader({
  title,
  titleAccessibilityLabel,
  scrollY,
  onPressTitle,
  onHeightChange,
  leftActions,
  rightActions,
  centerContent,
  children,
}: CollapsingLargeTitleHeaderProps) {
  const { systemColors, colorScheme } = useTheme();
  const nativeGlass = useNativeGlass();
  const insets = useSafeAreaInsets();
  const { progress, collapsed } = useCollapseProgress(scrollY);

  // Scrim colour resolved from the active scheme (see SCRIM_BACKGROUND) so it
  // flips on an in-app light↔dark toggle instead of sticking on the mount-time
  // PlatformColor.
  const scrimColor = SCRIM_BACKGROUND[colorScheme];

  // Only the centre content (which is leaving) fades — flattening its glass
  // mid-fade is invisible because it's disappearing. The capsule that *stays*
  // uses transform only, so the live glass survives.
  const centerFadeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.5], [1, 0], Extrapolation.CLAMP),
  }));
  const titleStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(progress.value, [0.5, 0.85], [6, 0], Extrapolation.CLAMP) },
      { scale: interpolate(progress.value, [0.5, 0.85], [0.94, 1], Extrapolation.CLAMP) },
    ],
  }));

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange(event.nativeEvent.layout.height),
    [onHeightChange],
  );

  return (
    <View pointerEvents="box-none" style={[styles.container, { paddingTop: insets.top }]} onLayout={handleLayout}>
      {/* Scrim: the screen background fading to clear, so content scrolling up
          doesn't bleed through the gaps between the islands. */}
      <LinearGradient
        pointerEvents="none"
        colors={[scrimColor, scrimColor, 'transparent'] as const}
        locations={[0, 0.7, 1]}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="box-none" style={styles.row}>
        {/* Left island (anchored left). */}
        {leftActions ? (
          <View pointerEvents="box-none" style={styles.leftAnchor}>
            {leftActions}
          </View>
        ) : null}

        {/* Centred at-rest control; fades out as the title takes over. */}
        {centerContent ? (
          <Animated.View pointerEvents={collapsed ? 'none' : 'box-none'} style={[styles.centerAnchor, centerFadeStyle]}>
            {centerContent}
          </Animated.View>
        ) : null}

        {/* Collapsed title capsule, centred; tap scrolls to the top. Transform-only
            entrance keeps the glass surface live (no opacity). */}
        {collapsed ? (
          <Animated.View pointerEvents="box-none" style={[styles.centerAnchor, titleStyle]}>
            <PressableSurface
              onPress={onPressTitle}
              feedback="scale"
              scaleTo={0.96}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={titleAccessibilityLabel ?? title}
            >
              <View
                style={[
                  styles.titlePill,
                  !nativeGlass && shadows.sm,
                  !nativeGlass && { borderWidth: StyleSheet.hairlineWidth, borderColor: systemColors.separator },
                ]}
              >
                <GlassSurface
                  glassEffectStyle="regular"
                  fallbackColor={systemColors.elevatedSurface}
                  borderRadius={TITLE_PILL_RADIUS}
                  style={StyleSheet.absoluteFill}
                  pointerEvents="none"
                />
                <Text
                  variant="subheadline"
                  numberOfLines={1}
                  ellipsizeMode="tail"
                  color={systemColors.label}
                  style={styles.titleText}
                >
                  {title}
                </Text>
              </View>
            </PressableSurface>
          </Animated.View>
        ) : null}

        {/* Right island(s), anchored right. */}
        {rightActions ? (
          <View pointerEvents="box-none" style={styles.rightAnchor}>
            {rightActions}
          </View>
        ) : null}
      </View>

      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
  },
  row: {
    height: TOP_ACTION_SIZE,
    marginHorizontal: ROW_GUTTER,
    marginVertical: spacing[1],
  },
  leftAnchor: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  rightAnchor: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  centerAnchor: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titlePill: {
    flexDirection: 'row',
    alignItems: 'center',
    height: TITLE_PILL_HEIGHT,
    borderRadius: TITLE_PILL_RADIUS,
    paddingHorizontal: 16,
    // Clip the absolutely-filled GlassSurface to the rounded corners on Android.
    overflow: 'hidden',
    // Match the board pill's width cap so a long title ellipsizes rather than
    // running under the left/right islands (both stay visible when collapsed).
    maxWidth: 180,
  },
  titleText: {
    fontWeight: '600',
    flexShrink: 1,
  },
});
