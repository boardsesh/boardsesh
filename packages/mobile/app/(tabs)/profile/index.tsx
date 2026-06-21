import { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type BottomSheet from '@gorhom/bottom-sheet';
import { useProfile, useYouProfileData } from '../../../src/lib/graphql/hooks';
import { useTheme } from '../../../src/providers/theme-provider';
import { ProfileTopChrome, type ProfileTabKey } from '../../../src/components/you/ProfileTopChrome';
import { YouFilterSheet } from '../../../src/components/you/YouFilterSheet';
import { ProgressTab } from '../../../src/components/you/ProgressTab';
import { SessionsTab } from '../../../src/components/you/SessionsTab';
import { LogbookTab } from '../../../src/components/you/LogbookTab';
import { SocialTab } from '../../../src/components/you/SocialTab';

// Screenshot mode selects the visible sub-tab via a `screenshotTab` deep-link
// param so the logbook/sessions shots are deterministic.
function isProfileTabKey(value: string | string[] | undefined): value is ProfileTabKey {
  return value === 'progress' || value === 'sessions' || value === 'logbook' || value === 'social';
}

export default function YouScreen() {
  const { t } = useTranslation('you');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();

  // The own profile's identity title. The reused sub-tabs render it in-body
  // (collapsing under the floating chrome); another climber's profile omits it.
  const dashboardTitle = t('metadata.dashboard.title');

  const { data: profile } = useProfile();
  const userId = profile?.id;
  const youData = useYouProfileData(userId);

  const filterSheetRef = useRef<BottomSheet | null>(null);
  const { screenshotTab } = useLocalSearchParams<{ screenshotTab?: string }>();
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
          <ProgressTab data={youData} topInset={chromeHeight} screenTitle={dashboardTitle} userId={userId} />
        ) : null}
        {activeTab === 'sessions' ? (
          <SessionsTab userId={userId} topInset={chromeHeight} screenTitle={dashboardTitle} />
        ) : null}
        {activeTab === 'logbook' ? (
          <LogbookTab userId={userId} topInset={chromeHeight} screenTitle={dashboardTitle} />
        ) : null}
        {activeTab === 'social' ? (
          <SocialTab userId={userId} topInset={chromeHeight} screenTitle={dashboardTitle} />
        ) : null}
      </View>

      <ProfileTopChrome
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        hasActiveFilters={youData.hasActiveFilters}
        onOpenFilters={openFilters}
        onHeightChange={setChromeHeight}
      />

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
