import { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import type { BottomSheet } from '@expo/ui/community/bottom-sheet';
import { useProfile, useYouProfileData } from '../../../src/lib/graphql/hooks';
import { useTheme } from '../../../src/providers/theme-provider';
import { ProfileTopChrome, type ProfileTabKey } from '../../../src/components/you/ProfileTopChrome';
import { YouFilterSheet } from '../../../src/components/you/YouFilterSheet';
import { ProgressTab } from '../../../src/components/you/ProgressTab';
import { SessionsTab } from '../../../src/components/you/SessionsTab';
import { LogbookTab } from '../../../src/components/you/LogbookTab';
import { ProfileClimbsTab } from '../../../src/components/you/ProfileClimbsTab';
import { SocialTab } from '../../../src/components/you/SocialTab';

// Screenshot mode selects the visible sub-tab via a `screenshotTab` deep-link
// param so the logbook/sessions shots are deterministic.
function isProfileTabKey(value: string | string[] | undefined): value is ProfileTabKey {
  return (
    value === 'progress' || value === 'sessions' || value === 'logbook' || value === 'climbs' || value === 'social'
  );
}

export default function YouScreen() {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();

  const { data: profile } = useProfile();
  const userId = profile?.id;
  const youData = useYouProfileData(userId);

  const filterSheetRef = useRef<BottomSheet | null>(null);
  const { screenshotTab, screenshotBetaShelf } = useLocalSearchParams<{
    screenshotTab?: string;
    screenshotBetaShelf?: string;
  }>();
  const [activeTab, setActiveTab] = useState<ProfileTabKey>(() =>
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && isProfileTabKey(screenshotTab) ? screenshotTab : 'progress',
  );
  // The profile tab stays mounted across screenshot shots, so re-sync the visible
  // sub-tab whenever the deep-link param changes (initial mount is covered by the
  // useState initialiser). Inert in normal builds — manual tab taps own the state.
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1') return;
    setActiveTab(isProfileTabKey(screenshotTab) ? screenshotTab : 'progress');
  }, [screenshotTab]);

  // Screenshot mode: open the climber's OWN beta grid — the "See all" target of
  // the profile beta shelf (`ProfileBetaShelf` -> `/users/[userId]/beta`). The
  // capture can't deep-link that route directly: it is keyed by user id, and an
  // id baked into a flow YAML is the same drift trap `SCREENSHOT_BOARDS` exists
  // to avoid. Resolving it here means the flow says only "me". Pushed rather
  // than scrolled to the shelf itself, which sits mid-way down a virtualized
  // profile list with no stable anchor to scroll to. One-shot, and gated on the
  // param so every other `/profile` shot is untouched. Dead-strips in normal
  // builds.
  const screenshotBetaPushedRef = useRef(false);
  useEffect(() => {
    if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE !== '1' || !screenshotBetaShelf) return;
    if (!userId || screenshotBetaPushedRef.current) return;
    screenshotBetaPushedRef.current = true;
    router.push({ pathname: '/users/[userId]/beta', params: { userId } });
  }, [screenshotBetaShelf, userId]);

  // The measured chrome height insets each sub-tab's scroll content; seed it to
  // the safe-area top plus the islands row + segmented control so the first paint
  // already clears the chrome before onLayout reports the real height.
  const [chromeHeight, setChromeHeight] = useState(() => insets.top + 96);

  const handleSelectTab = useCallback((key: ProfileTabKey) => {
    setActiveTab(key);
  }, []);

  const openFilters = useCallback(() => {
    filterSheetRef.current?.snapToIndex(0);
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: systemColors.background }]}>
      <View style={styles.page}>
        {activeTab === 'progress' ? (
          <ProgressTab data={youData} topInset={chromeHeight} userId={userId} onOpenFilters={openFilters} />
        ) : null}
        {activeTab === 'sessions' ? <SessionsTab userId={userId} topInset={chromeHeight} /> : null}
        {activeTab === 'logbook' ? <LogbookTab userId={userId} topInset={chromeHeight} /> : null}
        {activeTab === 'climbs' ? <ProfileClimbsTab userId={userId} topInset={chromeHeight} /> : null}
        {activeTab === 'social' ? <SocialTab userId={userId} topInset={chromeHeight} /> : null}
      </View>

      <ProfileTopChrome activeTab={activeTab} onSelectTab={handleSelectTab} onHeightChange={setChromeHeight} />

      <YouFilterSheet
        sheetRef={filterSheetRef}
        selectedBoard={youData.selectedBoard}
        onSelectBoard={youData.setSelectedBoard}
        timeframe={youData.timeframe}
        onSelectTimeframe={youData.setTimeframe}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  page: { flex: 1 },
});
