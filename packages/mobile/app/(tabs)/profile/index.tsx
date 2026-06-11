import { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type BottomSheet from '@gorhom/bottom-sheet';
import { useProfile, useYouProfileData } from '../../../src/lib/graphql/hooks';
import { useTheme } from '../../../src/providers/theme-provider';
import { ProfileTopChrome, type ProfileTabKey } from '../../../src/components/you/ProfileTopChrome';
import { YouFilterSheet } from '../../../src/components/you/YouFilterSheet';
import { ProgressTab } from '../../../src/components/you/ProgressTab';
import { SessionsTab } from '../../../src/components/you/SessionsTab';
import { LogbookTab } from '../../../src/components/you/LogbookTab';
import { SocialTab } from '../../../src/components/you/SocialTab';

export default function YouScreen() {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();

  const { data: profile } = useProfile();
  const userId = profile?.id;
  const youData = useYouProfileData(userId);

  const filterSheetRef = useRef<BottomSheet | null>(null);
  const [activeTab, setActiveTab] = useState<ProfileTabKey>('progress');

  // One scroll offset, owned here and handed to whichever sub-tab is mounted, so
  // the floating chrome's title collapse reads from the active list only. The
  // measured chrome height insets each sub-tab's scroll content; seed it to the
  // safe-area top plus the islands row + segmented control so the first paint
  // already clears the chrome before onLayout reports the real height.
  const scrollY = useSharedValue(0);
  const [chromeHeight, setChromeHeight] = useState(() => insets.top + 96);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollY.value = event.nativeEvent.contentOffset.y;
    },
    [scrollY],
  );

  // Each mounted sub-tab registers its scroll-to-top here; tapping the collapsed
  // title capsule dispatches to whichever is active. A ref (not state) so the
  // re-pointing on sub-tab switch doesn't re-render the chrome.
  const scrollToTopRef = useRef<(() => void) | null>(null);
  const registerScrollToTop = useCallback((scrollToTop: (() => void) | null) => {
    scrollToTopRef.current = scrollToTop;
  }, []);
  const handleScrollToTop = useCallback(() => {
    scrollToTopRef.current?.();
  }, []);

  const handleSelectTab = useCallback(
    (key: ProfileTabKey) => {
      // Re-tapping the active segment scrolls it to the top (the iOS convention),
      // not a no-op that would still snap the chrome open over a mid-scrolled list.
      if (key === activeTab) {
        scrollToTopRef.current?.();
        return;
      }
      setActiveTab(key);
    },
    [activeTab],
  );

  // Reset the shared scroll offset after the sub-tab has actually switched
  // (post-commit, once the outgoing list is unmounted) so its in-flight momentum
  // scroll events can't rewrite scrollY after the reset. The incoming list mounts
  // at offset 0, so the chrome shows the large title rather than a stale capsule.
  useEffect(() => {
    scrollY.value = 0;
  }, [activeTab, scrollY]);

  const openFilters = useCallback(() => {
    filterSheetRef.current?.snapToIndex(0);
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: systemColors.background }]}>
      <View style={styles.page}>
        {activeTab === 'progress' ? (
          <ProgressTab
            data={youData}
            onScroll={handleScroll}
            topInset={chromeHeight}
            registerScrollToTop={registerScrollToTop}
          />
        ) : null}
        {activeTab === 'sessions' ? (
          <SessionsTab
            userId={userId}
            onScroll={handleScroll}
            topInset={chromeHeight}
            registerScrollToTop={registerScrollToTop}
          />
        ) : null}
        {activeTab === 'logbook' ? (
          <LogbookTab
            userId={userId}
            onScroll={handleScroll}
            topInset={chromeHeight}
            registerScrollToTop={registerScrollToTop}
          />
        ) : null}
        {activeTab === 'social' ? (
          <SocialTab
            userId={userId}
            onScroll={handleScroll}
            topInset={chromeHeight}
            registerScrollToTop={registerScrollToTop}
          />
        ) : null}
      </View>

      <ProfileTopChrome
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        hasActiveFilters={youData.hasActiveFilters}
        onOpenFilters={openFilters}
        scrollY={scrollY}
        onPressTitle={handleScrollToTop}
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
