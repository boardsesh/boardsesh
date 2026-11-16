import { router, useLocalSearchParams } from 'expo-router';
import type { BottomSheet } from '@expo/ui/community/bottom-sheet';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ReadableColumn } from '../../../src/components/ReadableColumn';
import { LogbookTab } from '../../../src/components/you/LogbookTab';
import { ProfileClimbsTab } from '../../../src/components/you/ProfileClimbsTab';
import { ProfileTopChrome, type ProfileTabKey } from '../../../src/components/you/ProfileTopChrome';
import { ProgressTab } from '../../../src/components/you/ProgressTab';
import { SessionsTab } from '../../../src/components/you/SessionsTab';
import { SocialTab } from '../../../src/components/you/SocialTab';
import { YouFilterSheet } from '../../../src/components/you/YouFilterSheet';
import { useNativeRootHeader } from '../../../src/hooks/use-native-root-header';
import { useScrollEdgeBackdrop } from '../../../src/hooks/use-scroll-edge-backdrop';
import { useProfile, useYouProfileData } from '../../../src/lib/graphql/hooks';
import { useTheme } from '../../../src/providers/theme-provider';

export default function YouScreen() {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const nativeRootHeader = useNativeRootHeader();

  const { data: profile } = useProfile();
  const userId = profile?.id;
  const youData = useYouProfileData(userId);

  const filterSheetRef = useRef<BottomSheet | null>(null);
  const { tab } = useLocalSearchParams<{ tab?: string | string[] }>();
  const activeTab: ProfileTabKey =
    tab === 'sessions' || tab === 'logbook' || tab === 'climbs' || tab === 'social' ? tab : 'progress';

  // The measured chrome height insets each sub-tab's scroll content; seed it to
  // the safe-area top plus the islands row + segmented control so the first paint
  // already clears the chrome before onLayout reports the real height.
  const [chromeHeight, setChromeHeight] = useState(() => (nativeRootHeader ? 0 : insets.top + 96));

  const handleSelectTab = useCallback((key: ProfileTabKey) => {
    router.setParams({ tab: key });
  }, []);

  // Whether the visible sub-tab's list is under the floating segmented control:
  // the blur behind it shows only then. A store the lists write and the blur
  // reads, so neither a scroll nor the bar changing height re-renders this screen
  // and the sub-tab under it. `list` is undefined until a blur is mounted, which
  // keeps the lists under every opaque header free of scroll listeners.
  const scrollEdge = useScrollEdgeBackdrop();

  const openFilters = useCallback(() => {
    filterSheetRef.current?.snapToIndex(0);
  }, []);

  const renderLogbookHeader = useCallback(
    (controls: ReactNode, onHeightChange: (height: number) => void) => (
      <ProfileTopChrome
        activeTab="logbook"
        onSelectTab={handleSelectTab}
        onHeightChange={onHeightChange}
        scrollEdge={scrollEdge.backdrop}
      >
        {controls}
      </ProfileTopChrome>
    ),
    [handleSelectTab, scrollEdge.backdrop],
  );

  return (
    <View style={[styles.container, { backgroundColor: systemColors.background }]}>
      {activeTab === 'logbook' ? (
        <LogbookTab userId={userId} renderHeader={renderLogbookHeader} scrollEdge={scrollEdge.list} />
      ) : (
        <ReadableColumn style={styles.page}>
          {activeTab === 'progress' ? (
            <ProgressTab
              data={youData}
              topInset={chromeHeight}
              userId={userId}
              onOpenFilters={openFilters}
              scrollEdge={scrollEdge.list}
            />
          ) : null}
          {activeTab === 'sessions' ? (
            <SessionsTab userId={userId} topInset={chromeHeight} scrollEdge={scrollEdge.list} />
          ) : null}
          {activeTab === 'climbs' ? (
            <ProfileClimbsTab userId={userId} topInset={chromeHeight} scrollEdge={scrollEdge.list} />
          ) : null}
          {activeTab === 'social' ? (
            <SocialTab userId={userId} topInset={chromeHeight} scrollEdge={scrollEdge.list} />
          ) : null}
        </ReadableColumn>
      )}

      {activeTab !== 'logbook' ? (
        <ProfileTopChrome
          activeTab={activeTab}
          onSelectTab={handleSelectTab}
          onHeightChange={setChromeHeight}
          scrollEdge={scrollEdge.backdrop}
        />
      ) : null}

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
  // ReadableColumn supplies the 672pt cap, widened by any side safe area it pads.
  page: { flex: 1 },
});
