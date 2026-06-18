import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ONBOARDING_TIP_ACCESSORY_KEY } from '@boardsesh/key-value-storage';
import { OnboardingTipBanner } from './OnboardingTipBanner';
import { hasSeenTip, markTipSeen } from '../../lib/onboarding/onboarding-storage';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { spacing } from '../../theme/tokens';

/**
 * One-time tip teaching that the bottom accessory bar (the current-climb / queue
 * platter) always mirrors what's on the board. It fires the first time a current
 * climb exists — i.e. the first time the accessory bar is on screen — and never
 * again.
 *
 * On iOS 26 Liquid Glass the accessory is a UIKit-hosted native platter
 * (`NativeTabs.BottomAccessory`), which a JS tip can't attach to; everywhere else
 * it's the floating JS `PersistentQueueBar`. So this tip floats as its own
 * high-z absolute overlay just above the tab bar on BOTH variants, anchored with
 * the shared bottom-chrome geometry (`floatingControlBottom` already clears the
 * tab bar plus the active queue chrome / native accessory). No animation, so it's
 * Reduce-Motion-safe; the banner copy and close button are separate accessibility
 * elements.
 *
 * Mounted once at the app root (next to `PersistentQueueBar`) so it can watch
 * presence globally regardless of the active route.
 */
export function AccessoryOnboardingTip() {
  const { t } = useTranslation('common');
  // Presence comes from the bottom-chrome metrics (which already tracks it via
  // useStickyAccessoryPresence), so we don't double-subscribe to the sticky hook.
  const bottomChrome = useBottomChromeMetrics();
  const hasCurrentClimb = bottomChrome.hasCurrentClimb;
  const [tipVisible, setTipVisible] = useState(false);

  // Arm the tip the first time the accessory bar is on screen (a current climb
  // exists) AND it hasn't been seen. `hasSeenTip` returns true on a read error, so
  // a flaky store never nags. Re-checks whenever presence flips true so a climb
  // appearing later in the session still triggers it once.
  useEffect(() => {
    if (!hasCurrentClimb) return;
    let cancelled = false;
    void hasSeenTip(ONBOARDING_TIP_ACCESSORY_KEY).then((seen) => {
      if (cancelled || seen) return;
      setTipVisible(true);
      // Mark seen as soon as it's shown, so it's genuinely one-time: presence
      // flips true again on cold start (the queue head persists), so marking only
      // on dismiss would re-show the tip every launch until the user taps the X.
      void markTipSeen(ONBOARDING_TIP_ACCESSORY_KEY);
    });
    return () => {
      cancelled = true;
    };
  }, [hasCurrentClimb]);

  const dismissTip = useCallback(() => setTipVisible(false), []);

  // Tie the tip to the bar it points at: if the current climb clears (the
  // accessory bar disappears) before the user dismisses, hide the tip too. It
  // stays armed (tipVisible) and re-shows when the bar returns, until dismissed.
  if (!tipVisible || !hasCurrentClimb) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.overlay, { bottom: bottomChrome.floatingControlBottom + spacing[2] }]}
    >
      <OnboardingTipBanner
        text={t('mobile.onboarding.tips.accessory')}
        dismissLabel={t('actions.close')}
        onDismiss={dismissTip}
        icon="chevron.down"
        solid
      />
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    left: spacing[3],
    right: spacing[3],
    // Above the tab bar / native accessory in z-order. The root view paints this
    // sibling after the navigator, so it already stacks on top; the explicit
    // elevation/zIndex keeps it above the JS PersistentQueueBar on Android too.
    zIndex: 100,
    elevation: 100,
  },
});
