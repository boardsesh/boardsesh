// Profile navigation stays separate from the filters in the Progress section.
import { useCallback, useMemo } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Appbar } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../providers/theme-provider';
import { createVariantComponent } from '../../theme/variants';
import { spacing } from '../../theme/tokens';
import { SegmentedControl } from '../SegmentedControl';
import { MaterialTabs } from '../navigation/MaterialTabs';
import { CollapsingLargeTitleHeader, GlassActionToolbar } from '../chrome';
import { UserAvatarToolbarAction } from '../user-drawer/UserAvatarToolbarAction';

export type ProfileTabKey = 'progress' | 'sessions' | 'logbook' | 'climbs' | 'social';

export type ProfileTopChromeProps = {
  /** Selected sub-tab; drives the segmented control's pill / the active tab. */
  activeTab: ProfileTabKey;
  onSelectTab: (key: ProfileTabKey) => void;
  /** Report the measured chrome height so each sub-tab can inset its top padding. */
  onHeightChange: (height: number) => void;
};

export const ProfileTopChrome = createVariantComponent('ProfileTopChrome', {
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
      { key: 'climbs' as const, label: t('tabs.climbs') },
      { key: 'social' as const, label: t('tabs.social') },
    ],
    [t],
  );
}

function ProfileTopChromeMaterial({ activeTab, onSelectTab, onHeightChange }: ProfileTopChromeProps) {
  const { t } = useTranslation('you');
  const { systemColors, m3 } = useTheme();
  const insets = useSafeAreaInsets();

  const dashboardTitle = t('metadata.dashboard.title');
  const tabOptions = useSegmentOptions();

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange(event.nativeEvent.layout.height),
    [onHeightChange],
  );

  return (
    <View
      // NOT box-none — the opaque Material band must swallow touches; see ClimbTopChrome for the RNGH mechanism.
      pointerEvents="auto"
      style={[
        styles.materialContainer,
        {
          paddingTop: insets.top,
          backgroundColor: systemColors.secondaryBackground,
          borderBottomColor: systemColors.separator,
        },
      ]}
      onLayout={handleLayout}
    >
      <Appbar.Header
        statusBarHeight={0}
        mode="small"
        elevated
        style={[styles.materialAppbar, { backgroundColor: systemColors.secondaryBackground }]}
      >
        <UserAvatarToolbarAction variant="material" />
        {/* No visible title — the sub-tab group below already names the surface
            (matches Liquid Glass, which never rendered one). The empty Content is
            the flex spacer that keeps the avatar at the leading edge;
            dashboardTitle still labels the tabs for screen readers. */}
        <Appbar.Content title="" />
      </Appbar.Header>

      {/* Inner box-none is fine: the outer `auto` container already claims the RNGH
          pointer, so this wrapper only needs RN hit-testing to reach the tabs. */}
      <View pointerEvents="box-none" style={[styles.materialTabsRow, { borderTopColor: m3.outlineVariant }]}>
        <MaterialTabs
          options={tabOptions}
          selectedKey={activeTab}
          onSelect={onSelectTab}
          accessibilityLabel={dashboardTitle}
        />
      </View>
    </View>
  );
}

function ProfileTopChromeGlass({ activeTab, onSelectTab, onHeightChange }: ProfileTopChromeProps) {
  const { t } = useTranslation('you');

  const dashboardTitle = t('metadata.dashboard.title');
  const segmentOptions = useSegmentOptions();

  const leftActions = (
    <GlassActionToolbar actionCount={1}>
      <UserAvatarToolbarAction variant="glass" />
    </GlassActionToolbar>
  );

  return (
    <CollapsingLargeTitleHeader onHeightChange={onHeightChange} leftActions={leftActions}>
      {/* The native iOS segmented control brings its own track/background, so it
          renders directly — wrapping it in the old GlassSurface track doubled the
          border. The padded segmentStack positions it under the large title. */}
      <View pointerEvents="box-none" style={styles.segmentStack}>
        <SegmentedControl
          options={segmentOptions}
          selectedKey={activeTab}
          onSelect={onSelectTab}
          trackColor="transparent"
          textVariant="footnote"
          accessibilityLabel={dashboardTitle}
        />
      </View>
    </CollapsingLargeTitleHeader>
  );
}

const styles = StyleSheet.create({
  segmentStack: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  materialContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  materialAppbar: {
    elevation: 0,
    shadowOpacity: 0,
  },
  materialTabsRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
