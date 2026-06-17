// One-time coachmark teaching that the active-climb strip can be tucked away.
// Shown once, only while the bar is in the dismissible state (a current climb,
// inside the tabs, and no climbing signal), then never again. It teaches the
// affordance without prescribing the exact gesture — the swipe (JS bar) and the
// hide chevron (native platter) are both discoverable from here.

import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useHasActiveClimb } from '../../providers/queue-provider';
import { useIsActivelyClimbing } from '../../hooks/use-actively-climbing';
import { useAccessoryDismissed } from '../../hooks/use-accessory-dismissed';
import { useAccessoryDismissHintSeen } from '../../lib/accessory-dismiss-hint-store';
import { borderRadius, shadows, spacing } from '../../theme/tokens';
import { timing } from '../../theme/animations';

// Auto-retire the hint if the user neither acts on it nor taps "Got it"; one
// exposure is enough and it should never linger.
const HINT_AUTO_RETIRE_MS = 8000;

export function AccessoryDismissHint() {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const reduceMotion = useReduceMotion();
  const bottomChrome = useBottomChromeMetrics();
  const hasClimb = useHasActiveClimb();
  const isActivelyClimbing = useIsActivelyClimbing();
  const dismissed = useAccessoryDismissed();
  const { seen, loaded, markSeen } = useAccessoryDismissHintSeen();

  // The bar is currently visible AND in the dismissible (no-signal) state.
  const barDismissibleNow = bottomChrome.insideTabs && hasClimb && !isActivelyClimbing && !dismissed;
  const shouldOffer = loaded && !seen && barDismissibleNow;

  const [showing, setShowing] = useState(false);
  const offeredRef = useRef(false);

  // Offer the hint exactly once, ever. Persist "seen" immediately (so it never
  // returns across launches) and latch local visibility so marking it seen — which
  // flips `shouldOffer` false on the same tick — doesn't yank it off screen.
  useEffect(() => {
    if (offeredRef.current || !shouldOffer) return;
    offeredRef.current = true;
    markSeen();
    setShowing(true);
  }, [shouldOffer, markSeen]);

  // Auto-retire so it never lingers; the timer is tied to `showing`, not the
  // offer condition, so it isn't cleared the instant "seen" is persisted.
  useEffect(() => {
    if (!showing) return undefined;
    const timer = setTimeout(() => setShowing(false), HINT_AUTO_RETIRE_MS);
    return () => clearTimeout(timer);
  }, [showing]);

  // Retire the moment the user acts on it (dismisses) or starts climbing.
  useEffect(() => {
    if (showing && (dismissed || isActivelyClimbing)) setShowing(false);
  }, [showing, dismissed, isActivelyClimbing]);

  // The hint is a passive, time-limited overlay, so screen-reader users would
  // otherwise never hear it — announce the copy when it appears.
  useEffect(() => {
    if (showing) AccessibilityInfo.announceForAccessibility(t('mobile.accessoryBar.coachmarkHint'));
  }, [showing, t]);

  // Only paint while latched AND the bar is genuinely on screen beneath it (so it
  // can't float over a pushed root screen or after the bar is gone).
  if (!showing || !barDismissibleNow) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      entering={reduceMotion ? undefined : FadeIn.duration(timing.normal)}
      exiting={reduceMotion ? undefined : FadeOut.duration(timing.fast)}
      style={[styles.wrap, { bottom: bottomChrome.floatingControlBottom + spacing[2] }]}
    >
      <View
        style={[
          styles.bubble,
          shadows.md,
          { backgroundColor: systemColors.elevatedSurface, borderColor: systemColors.separator },
        ]}
      >
        <Text variant="footnote" color={systemColors.label} numberOfLines={2} style={styles.label}>
          {t('mobile.accessoryBar.coachmarkHint')}
        </Text>
        <Pressable
          onPress={() => setShowing(false)}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.accessoryBar.coachmarkGotIt')}
          hitSlop={spacing[2]}
        >
          <Text variant="footnote" color={systemColors.accent} style={styles.action}>
            {t('mobile.accessoryBar.coachmarkGotIt')}
          </Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: spacing[4],
    right: spacing[4],
    alignItems: 'center',
  },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    maxWidth: 420,
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[4],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  label: {
    flexShrink: 1,
  },
  action: {
    fontWeight: '600',
  },
});
