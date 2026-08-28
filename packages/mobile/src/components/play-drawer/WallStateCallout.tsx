// The wall-state pill's tap explainer: one line of plain language about what the
// wall is doing, plus the actions that change it.
//
// An anchored transient card, NOT a sheet — a one-line explainer doesn't clear
// the bar in docs/mobile-sheets-vs-routes.md, and a sheet would cover the board
// the sentence is about. It's absolutely positioned inside the drawer's first
// screen (a sibling of the swipeable header, so it doesn't ride the swipe
// translate) and overlays board art: zero layout cost, no height stolen.
//
// It behaves like a modal for assistive tech even though it isn't one visually:
// the scrim and the card share ONE container that carries `accessibilityViewIsModal`
// (iOS), focus is moved onto the body sentence on open, and the host hides the
// drawer content behind it from TalkBack while it's up. That matters because in
// some states the card offers no action at all — the labelled scrim is then the
// only way out, so it has to stay inside the modal region.
//
// Dismisses on outside tap, Android hardware back, an 8s timeout, and — via the
// host — any state change or navigation.

import { memo, useEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo, BackHandler, findNodeHandle, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInUp, useReducedMotion } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { spacing, borderRadius, shadows } from '../../theme/tokens';
import { springs } from '../../theme/animations';
import { timingFor } from '../../theme/motion-config';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import { glassSize } from '../../theme/layout';
import { Text } from '../Text';
import { BoardDriverAvatar } from '../board-presence/BoardDriverAvatar';
import { useWallDriver } from './use-wall-driver';
import type { WallStatePillState } from './WallStatePill';

/** Wide enough for one sentence at Dynamic Type, narrow enough to stay a card. */
const CALLOUT_MAX_WIDTH = 300;
/** Paints over the board art; the drawer's own sub-sheets present above it. */
const CALLOUT_Z = 20;
const CALLOUT_FADE_MS = 150;
/** The Liquid Glass settle: a hint of travel, not a sheet-sized entrance. */
const CALLOUT_SETTLE_PX = 4;
/** An explainer, not a decision — it stands down on its own if left alone. */
const CALLOUT_AUTO_DISMISS_MS = 8000;

type WallStateCalloutProps = {
  state: WallStatePillState;
  /** Y offset inside the drawer's first screen: the header's measured bottom edge. */
  top: number;
  /**
   * Start browsing from the displayed climb. Omitted when this viewer can't —
   * which in PR A1 is everyone, because holding a latch across navigation is the
   * A2 half of the feature (see PlayDrawer).
   */
  onBrowseFromHere?: () => void;
  /** Drop the pinned preview and go back to the committed climb. Omitted when
   *  there's no preview pinned, so there's nothing to go back from. */
  onBackToLive?: () => void;
  onDismiss: () => void;
};

function WallStateCalloutImpl({ state, top, onBrowseFromHere, onBackToLive, onDismiss }: WallStateCalloutProps) {
  const { t } = useTranslation('session');
  const { variant, systemColors, brandColors, m3SurfaceContainers, materialElevation, motion } = useTheme();
  const reduceMotion = useReducedMotion();
  const router = useRouter();
  const { driver, name: driverName, litAgo } = useWallDriver();
  const bodyRef = useRef<View>(null);

  useEffect(() => {
    const handle = setTimeout(onDismiss, CALLOUT_AUTO_DISMISS_MS);
    return () => clearTimeout(handle);
  }, [onDismiss]);

  // Land the screen reader on the sentence the climber just asked for, rather
  // than wherever the focus happened to be when the card claimed the modal.
  useEffect(() => {
    const nodeHandle = findNodeHandle(bodyRef.current);
    if (nodeHandle == null) return;
    AccessibilityInfo.setAccessibilityFocus(nodeHandle);
  }, []);

  // Android hardware back closes the explainer instead of dismissing the whole
  // player — the same "innermost transient surface first" order a sheet gets.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onDismiss();
      return true;
    });
    return () => subscription.remove();
  }, [onDismiss]);

  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  const cardSurface = isMaterial
    ? [{ backgroundColor: m3SurfaceContainers.high }, materialElevation.level2]
    : [
        {
          backgroundColor: systemColors.elevatedSurface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: systemColors.separator,
        },
        shadows.md,
      ];

  // Material fades on the M3 standard curve; Liquid Glass drops the last 4pt on
  // a gentle spring, so the card reads as settling under the pill it came from.
  const entering = useMemo(() => {
    if (reduceMotion) return undefined;
    if (isMaterial) {
      const { duration, easing } = timingFor(motion.standard);
      const fade = FadeIn.duration(duration ?? CALLOUT_FADE_MS);
      return easing ? fade.easing(easing) : fade;
    }
    return FadeInUp.springify()
      .damping(springs.gentle.damping)
      .stiffness(springs.gentle.stiffness)
      .mass(springs.gentle.mass)
      .withInitialValues({ transform: [{ translateY: -CALLOUT_SETTLE_PX }] });
  }, [reduceMotion, isMaterial, motion.standard]);

  const body =
    state === 'onWall'
      ? t('playView.wallState.onWallHint')
      : state === 'live'
        ? t('playView.wallState.liveHint')
        : t('playView.wallState.browsingHint');

  const driverUserId = driver?.userId ?? null;
  const handleOpenDriverProfile = () => {
    if (!driverUserId) return;
    router.push({ pathname: '/users/[userId]', params: { userId: driverUserId } });
  };

  return (
    // One modal region for the pair: on iOS `accessibilityViewIsModal` hides
    // everything OUTSIDE the view it sits on, so putting it on the card alone
    // would hide the dismiss scrim — the one element some states can offer.
    <View accessibilityViewIsModal style={styles.modalRegion}>
      {/* Outside tap dismisses. Labelled rather than decorative so assistive tech
          has a way out that isn't the hardware back button. */}
      <Pressable
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel={t('playView.closeAria')}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View entering={entering} style={[styles.card, { top }, ...cardSurface]}>
        <View ref={bodyRef} accessible accessibilityRole="text">
          <Text variant="footnote" color={systemColors.label} style={styles.body}>
            {body}
          </Text>
        </View>

        {/* Who lit it, and how long ago — the recency the 24pt pill avatar is too
            small to print, and the profile tap the pill deliberately gave up. */}
        {state === 'onWall' ? (
          <Pressable
            onPress={handleOpenDriverProfile}
            disabled={!driverUserId}
            accessibilityRole={driverUserId ? 'button' : undefined}
            accessibilityLabel={
              driverName
                ? t('mobile.boardPresence.drivenByA11y', { name: driverName })
                : t('mobile.boardPresence.drivenByAnonA11y')
            }
            style={styles.driverRow}
          >
            <BoardDriverAvatar
              size={24}
              userId={null}
              uri={driver?.avatarUrl ?? null}
              name={driverName}
              status="none"
            />
            <Text variant="subheadline" color={systemColors.label} numberOfLines={1} style={styles.driverName}>
              {driverName ?? t('mobile.boardPresence.drivenByAnonA11y')}
            </Text>
            {litAgo ? (
              <Text variant="caption1" color={systemColors.secondaryLabel}>
                {litAgo}
              </Text>
            ) : null}
          </Pressable>
        ) : null}

        <View style={styles.actions}>
          {onBrowseFromHere ? (
            <Pressable onPress={onBrowseFromHere} accessibilityRole="button" style={styles.action}>
              <Text variant="subheadline" color={brandColors.tint} style={styles.actionLabel}>
                {t('playView.wallState.browseFromHere')}
              </Text>
            </Pressable>
          ) : null}
          {onBackToLive ? (
            <Pressable onPress={onBackToLive} accessibilityRole="button" style={styles.action}>
              <Text variant="subheadline" color={brandColors.tint} style={styles.actionLabel}>
                {t('playView.wallState.backToLive')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </Animated.View>
    </View>
  );
}

export const WallStateCallout = memo(WallStateCalloutImpl);

const styles = StyleSheet.create({
  modalRegion: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: CALLOUT_Z,
  },
  card: {
    position: 'absolute',
    left: spacing[4],
    maxWidth: CALLOUT_MAX_WIDTH,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    gap: spacing[1],
  },
  body: {
    // A growing surface, so it keeps Text's 1.5 Dynamic Type ceiling.
    lineHeight: 20,
  },
  driverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: glassSize.inline,
  },
  driverName: {
    flexShrink: 1,
    minWidth: 0,
    fontWeight: '600',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[4],
  },
  action: {
    height: glassSize.inline,
    justifyContent: 'center',
  },
  actionLabel: {
    fontWeight: '600',
  },
});
