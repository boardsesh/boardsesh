// Profile navigation stays separate from the filters in the Progress section.
import { type ComponentProps, type ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import type { ScrollEdgeBackdrop } from '../../hooks/use-scroll-edge-backdrop';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { createVariantComponent } from '../../theme/variants';
import { SegmentedControl } from '../SegmentedControl';
import { CollapsingLargeTitleHeader } from '../chrome';
import { MaterialAppBarTitle } from '../chrome/MaterialAppBarTitle';
import { MaterialTopAppBar } from '../chrome/MaterialTopAppBar';
import { MaterialTabs } from '../navigation/MaterialTabs';
import { ScrollableTabs } from '../navigation/ScrollableTabs';

export type ProfileTabKey = 'progress' | 'sessions' | 'logbook' | 'climbs' | 'social';

export type ProfileTopChromeViewProps = {
  displayName?: string | null;
  accountAction?: ReactNode;
  shareAction?: ReactNode;
  leftItems?: ComponentProps<typeof CollapsingLargeTitleHeader>['leftItems'];
  rightItems?: ComponentProps<typeof CollapsingLargeTitleHeader>['rightItems'];
  /** Selected sub-tab; drives the segmented control's pill / the active tab. */
  activeTab: ProfileTabKey;
  onSelectTab: (key: ProfileTabKey) => void;
  /** Report the measured chrome height so each sub-tab can inset its top padding. */
  onHeightChange: (height: number) => void;
  /** Controls below the tabs, included in the same measured header. */
  children?: ReactNode;
  /**
   * Liquid Glass only: keep the painted band behind the header instead of letting
   * it float over the list. Logbook sets it: its `children` include a bare text
   * heading that needs an opaque background over scrolling rows.
   * Material's header is always opaque.
   */
  opaqueControls?: boolean;
  /** Legacy scroll-edge wiring. Native supplementary controls do not attach a backdrop. */
  scrollEdge?: ScrollEdgeBackdrop;
};

export const ProfileTopChromeView = createVariantComponent('ProfileTopChromeView', {
  liquidGlass: ProfileTopChromeGlass,
  material: ProfileTopChromeMaterial,
});

function useSegmentOptions() {
  const { t } = useTranslation('you');
  return useMemo(
    () => [
      { key: 'progress' as const, label: t('tabs.progress') },
      { key: 'sessions' as const, label: t('tabs.sessions') },
      { key: 'logbook' as const, label: t('tabs.logbook') },
      { key: 'climbs' as const, label: t('tabs.created') },
      { key: 'social' as const, label: t('tabs.social') },
    ],
    [t],
  );
}

function ProfileTopChromeMaterial({
  activeTab,
  onSelectTab,
  onHeightChange,
  children,
  scrollEdge,
  displayName,
  accountAction,
  shareAction,
}: ProfileTopChromeViewProps) {
  const { t } = useTranslation('you');
  const { t: tCommon } = useTranslation('common');

  const dashboardTitle = t('metadata.dashboard.title');
  const tabOptions = useSegmentOptions();
  const { fontScale } = useWindowDimensions();
  const Tabs = fontScale > 1.3 ? ScrollableTabs : MaterialTabs;

  return (
    <MaterialTopAppBar
      onHeightChange={onHeightChange}
      scrollEdge={scrollEdge}
      below={
        <>
          {/* Inner box-none is fine: the band already claims the RNGH pointer, so
              this wrapper only needs RN hit-testing to reach the tabs. */}
          <View pointerEvents="box-none">
            <Tabs
              options={tabOptions}
              selectedKey={activeTab}
              onSelect={onSelectTab}
              accessibilityLabel={dashboardTitle}
            />
          </View>
          {children}
        </>
      }
    >
      {accountAction}
      {/* The page is the climber's own profile, so it carries their name; the tabs
          below switch views inside it. Falls back to "Profile" until it loads. */}
      <MaterialAppBarTitle title={displayName || tCommon('mobile.nav.profile')} />
      {shareAction}
    </MaterialTopAppBar>
  );
}

function ProfileTopChromeGlass({
  activeTab,
  onSelectTab,
  onHeightChange,
  children,
  opaqueControls,
  scrollEdge,
  accountAction,
  leftItems,
  rightItems,
  shareAction,
}: ProfileTopChromeViewProps) {
  const { t } = useTranslation('you');
  const { systemColors } = useTheme();

  const dashboardTitle = t('metadata.dashboard.title');
  const segmentOptions = useSegmentOptions();
  const { fontScale } = useWindowDimensions();

  return (
    <CollapsingLargeTitleHeader
      onHeightChange={onHeightChange}
      leftActions={accountAction}
      leftItems={leftItems}
      rightItems={rightItems}
      rightActions={shareAction}
      opaqueControls={opaqueControls}
      scrollEdge={scrollEdge}
    >
      {/* The native track is translucent. Its local opaque backing keeps tab labels
          readable over list content without adding glass or covering child filters. */}
      <View pointerEvents="box-none" style={[styles.segmentStack, { backgroundColor: systemColors.background }]}>
        {fontScale > 1.3 ? (
          <ScrollableTabs
            options={segmentOptions}
            selectedKey={activeTab}
            onSelect={onSelectTab}
            accessibilityLabel={dashboardTitle}
          />
        ) : (
          <SegmentedControl
            options={segmentOptions}
            selectedKey={activeTab}
            onSelect={onSelectTab}
            trackColor="transparent"
            textVariant="footnote"
            accessibilityLabel={dashboardTitle}
          />
        )}
      </View>
      {children}
    </CollapsingLargeTitleHeader>
  );
}

const styles = StyleSheet.create({
  segmentStack: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
});
