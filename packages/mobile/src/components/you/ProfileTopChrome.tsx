// Top chrome for the Profile ("You") tab, routed by UI variant.
//
// Liquid Glass: the board-agnostic CollapsingLargeTitleHeader (no board pill —
// unlike Climbs/Discover) with an account-avatar island on the left, an optional
// filter island on the right (the Progress sub-tab only), and the
// Progress/Sessions/Logbook segmented control (glass-track-wrapped) as its
// below-row content.
//
// Material: an absolutely-positioned, onHeightChange-measured M3 small app bar
// (mirroring ClimbTopChrome) — the account avatar, dashboard title via
// Appbar.Content, the Progress-only filter Appbar.Action, and the MaterialTabs primary tabs as
// the app bar's bottom row.

import { useCallback, useMemo } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Appbar } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../providers/theme-provider';
import { createVariantComponent } from '../../theme/variants';
import { useNativeGlass } from '../../hooks/use-native-glass';
import { spacing, shadows } from '../../theme/tokens';
import { Icon } from '../Icon';
import { iconMap } from '../icon-map';
import { GlassSurface } from '../GlassSurface';
import { SegmentedControl } from '../SegmentedControl';
import { MaterialTabs } from '../navigation/MaterialTabs';
import { CollapsingLargeTitleHeader, GlassActionToolbar, GlassToolbarAction } from '../chrome';
import { UserAvatarToolbarAction } from '../user-drawer/UserAvatarToolbarAction';

// The segmented control floats over the chrome's faded scrim with scrolling
// content behind it, so it needs its own glass track to stay legible and to give
// the opaque selected thumb something to pop against (matching the Climbs search
// capsule's treatment). 10 leaves a hair of glass around the thumb's radius-7 tile.
const SEGMENT_TRACK_RADIUS = 10;

export type ProfileTabKey = 'progress' | 'sessions' | 'logbook' | 'social';

export type ProfileTopChromeProps = {
  /** Selected sub-tab; drives the segmented control's pill / the active tab. */
  activeTab: ProfileTabKey;
  onSelectTab: (key: ProfileTabKey) => void;
  /** Tints the filter island accent when the Progress filters are narrowed. */
  hasActiveFilters: boolean;
  /** Open the Progress filter sheet (only reachable from the Progress sub-tab). */
  onOpenFilters: () => void;
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
      { key: 'social' as const, label: t('tabs.social') },
    ],
    [t],
  );
}

function ProfileTopChromeMaterial({
  activeTab,
  onSelectTab,
  hasActiveFilters,
  onOpenFilters,
  onHeightChange,
}: ProfileTopChromeProps) {
  const { t } = useTranslation('you');
  const { systemColors, brandColors, m3 } = useTheme();
  const insets = useSafeAreaInsets();

  const dashboardTitle = t('metadata.dashboard.title');
  const tabOptions = useSegmentOptions();

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange(event.nativeEvent.layout.height),
    [onHeightChange],
  );

  // The filter action only makes sense on Progress (the only sub-tab the filter
  // sheet narrows); Sessions/Logbook show none.
  const filterColor = hasActiveFilters ? (brandColors.primary as string) : (systemColors.label as string);

  return (
    <View
      pointerEvents="box-none"
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
        <Appbar.Content title={dashboardTitle} color={systemColors.label as string} />
        {activeTab === 'progress' ? (
          <Appbar.Action
            icon={iconMap.filter.android}
            color={filterColor}
            onPress={onOpenFilters}
            accessibilityLabel={t('mobile.filter.title')}
          />
        ) : null}
      </Appbar.Header>

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

function ProfileTopChromeGlass({
  activeTab,
  onSelectTab,
  hasActiveFilters,
  onOpenFilters,
  onHeightChange,
}: ProfileTopChromeProps) {
  const { t } = useTranslation('you');
  const { systemColors, brandColors } = useTheme();
  const nativeGlass = useNativeGlass();

  const dashboardTitle = t('metadata.dashboard.title');
  const segmentOptions = useSegmentOptions();

  const leftActions = (
    <GlassActionToolbar actionCount={1}>
      <UserAvatarToolbarAction variant="glass" />
    </GlassActionToolbar>
  );

  // The filter island only makes sense on Progress (the only sub-tab the filter
  // sheet narrows); Sessions/Logbook show no right island.
  const rightActions =
    activeTab === 'progress' ? (
      <GlassActionToolbar actionCount={1}>
        <GlassToolbarAction onPress={onOpenFilters} accessibilityLabel={t('mobile.filter.title')}>
          <Icon name="filter" size={22} color={hasActiveFilters ? brandColors.primary : systemColors.label} />
        </GlassToolbarAction>
      </GlassActionToolbar>
    ) : undefined;

  return (
    <CollapsingLargeTitleHeader onHeightChange={onHeightChange} leftActions={leftActions} rightActions={rightActions}>
      <View pointerEvents="box-none" style={styles.segmentStack}>
        <View
          style={[
            styles.segmentTrack,
            !nativeGlass && shadows.sm,
            !nativeGlass && { borderWidth: StyleSheet.hairlineWidth, borderColor: systemColors.separator },
          ]}
        >
          <GlassSurface
            glassEffectStyle="regular"
            fallbackColor={systemColors.fill}
            borderRadius={SEGMENT_TRACK_RADIUS}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <SegmentedControl
            options={segmentOptions}
            selectedKey={activeTab}
            onSelect={onSelectTab}
            trackColor="transparent"
            textVariant="footnote"
            accessibilityLabel={dashboardTitle}
          />
        </View>
      </View>
    </CollapsingLargeTitleHeader>
  );
}

const styles = StyleSheet.create({
  segmentStack: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
  segmentTrack: {
    borderRadius: SEGMENT_TRACK_RADIUS,
    // Clip the absolutely-filled GlassSurface to the rounded corners on Android.
    overflow: 'hidden',
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
