import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSegments } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ONBOARDING_TIP_ACCESSORY_KEY, ONBOARDING_TIP_CLIMBS_TAB_KEY } from '@boardsesh/key-value-storage';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { OnboardingTipBanner } from './OnboardingTipBanner';
import { hasSeenTip, markTipSeen } from '../../lib/onboarding/onboarding-storage';
import { isNewAccount } from '../../lib/onboarding/first-board-picker-decision';
import { tabsActiveSegment } from '../../lib/route-segments';
import { nowMs } from '../../lib/clock';
import { track } from '../../lib/analytics';
import { useProfile } from '../../lib/graphql/hooks';
import { useAuth } from '../../providers/auth-provider';
import { useNativeTabBar } from '../../hooks/use-bottom-accessory';
import { useStickyAccessoryPresence } from '../../hooks/use-sticky-accessory-presence';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { spacing } from '../../theme/tokens';

const CLIMBS_TAB = 'climbs';

type TipPhase = 'waiting' | 'showing' | 'done';

/**
 * One-time tip for new accounts on iOS 26 Liquid Glass iPhones (#5654): "To get
 * back to your climbs, tap the magnifier in the tab bar."
 *
 * There the Climbs tab is the tab bar's search-role item, a lone magnifier set
 * apart from the other tabs with no label, so a newcomer who leaves Climbs
 * can read it as a search button and never find their way back. The tip shows
 * the first time such an account is on another tab, floating just above the
 * tab bar the way `AccessoryOnboardingTip` does.
 *
 * Never on Android, on an older iPhone, on an iPad or on the Material variant:
 * those get the JS tab bar, where Climbs is a labelled tab like the rest.
 * `useNativeTabBar()` is exactly that split.
 *
 * Once per device: the seen flag is written the moment it shows, so a
 * force-quit mid-tip cannot bring it back. It stays up while the climber moves
 * between other tabs, and goes when they dismiss it or tap back to Climbs,
 * which is what it asked them to do. It waits while the accessory tip is still
 * due, and steps aside if that tip comes due while this one is up, because
 * both float in the same place.
 */
export function ClimbsTabReturnTip() {
  const { t } = useTranslation('common');
  const nativeTabBar = useNativeTabBar();
  const { isAuthenticated } = useAuth();
  const { data: profile } = useProfile({ enabled: isAuthenticated && nativeTabBar });
  const activeTab = tabsActiveSegment(useSegments());
  const hasCurrentClimb = useStickyAccessoryPresence();
  const bottomChrome = useBottomChromeMetrics();
  const [phase, setPhase] = useState<TipPhase>('waiting');

  const eligible = nativeTabBar && isAuthenticated && isNewAccount(profile?.createdAt, nowMs());
  const onOtherTab = activeTab !== null && activeTab !== CLIMBS_TAB;

  useEffect(() => {
    if (phase !== 'waiting' || !eligible || !onOtherTab) return;
    let cancelled = false;
    void (async () => {
      // `hasSeenTip` reads a failure as seen, so a flaky store never nags.
      if (await hasSeenTip(ONBOARDING_TIP_CLIMBS_TAB_KEY)) {
        if (!cancelled) setPhase('done');
        return;
      }
      // The accessory tip arms whenever a climb is current and takes the same
      // slot above the tab bar. Let it have its turn; the next tab change
      // looks again.
      if (hasCurrentClimb && !(await hasSeenTip(ONBOARDING_TIP_ACCESSORY_KEY))) return;
      if (cancelled) return;
      markTipSeen(ONBOARDING_TIP_CLIMBS_TAB_KEY).catch(() => undefined);
      track(SHARED_EVENTS.ClimbsTabTipShown, { fromTab: activeTab });
      setPhase('showing');
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, eligible, onOtherTab, hasCurrentClimb, activeTab]);

  // Back on Climbs: the tip has done its job.
  useEffect(() => {
    if (phase === 'showing' && activeTab === CLIMBS_TAB) setPhase('done');
  }, [phase, activeTab]);

  // The other order: a climb became current while this tip was up (a newcomer
  // opened one from Home, Discover or a playlist, then closed /play back onto
  // that tab). The accessory tip arms on that and floats in this same slot, so
  // this one steps aside for good rather than render on top of it. It has
  // already shown and been marked seen, so it does not come back.
  useEffect(() => {
    if (phase !== 'showing' || !hasCurrentClimb) return;
    let cancelled = false;
    void hasSeenTip(ONBOARDING_TIP_ACCESSORY_KEY).then((accessorySeen) => {
      if (!cancelled && !accessorySeen) setPhase('done');
    });
    return () => {
      cancelled = true;
    };
  }, [phase, hasCurrentClimb]);

  const dismissTip = useCallback(() => {
    setPhase('done');
  }, []);

  // Only over a tab, where the bar it points at is on screen. A root modal over
  // the tabs hides it; it comes back with the tabs until it is done.
  if (phase !== 'showing' || !onOtherTab) return null;

  return (
    <View
      pointerEvents="box-none"
      style={[styles.overlay, { bottom: bottomChrome.floatingControlBottom + spacing[2] }]}
    >
      <OnboardingTipBanner
        text={t('mobile.onboarding.tips.climbsTab')}
        dismissLabel={t('actions.close')}
        onDismiss={dismissTip}
        icon="search"
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
    // Same stacking as AccessoryOnboardingTip: a root sibling painted after the
    // navigator, lifted explicitly so it stays above the queue chrome.
    zIndex: 100,
    elevation: 100,
  },
});
