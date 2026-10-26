import { useNativeRootHeader } from '../../hooks/use-native-root-header';
// Top chrome for the Home (feed) tab, routed by UI variant.
//
// Liquid Glass: the floating chrome shared with the other tabs — an always-on
// progressive blur plus a row of glass islands (account avatar left, the
// `FeedScopeTitle` title-menu pill centred, and a two-slot trailing island
// holding notifications + find-climbers). The feed scrolls under the blur.
//
// Material: the shared `MaterialTopAppBar` — the account avatar, "Home" as the
// title with the feed scope under it (the `FeedScopeTitle` title-menu), then the
// notifications and find-climbers `Appbar.Action`s. Home has no board/angle/light
// controls and no create action, so the bar stays avatar · title · notifications ·
// find-climbers.

import { useCallback } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Appbar } from 'react-native-paper';
import { useRouter } from 'expo-router';
import { useTheme } from '../../providers/theme-provider';
import { createVariantComponent } from '../../theme/variants';
import { spacing } from '../../theme/tokens';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { iconMap } from '../icon-map';
import { type AppMenuAction } from '../AppMenu';
import { ProgressiveBlur } from '../ProgressiveBlur';
import {
  GlassActionToolbar,
  GlassToolbarAction,
  NATIVE_ACTION_SIZE,
  TOP_ACTION_SIZE,
  toolbarGlyphSize,
} from '../chrome';
import { NotificationsToolbarAction } from '../chrome/NotificationsToolbarAction';
import { UserAvatarToolbarAction } from '../user-drawer/UserAvatarToolbarAction';
import { NativeRootHeader } from '../chrome/NativeRootHeader';
import { MaterialAppBarTitle } from '../chrome/MaterialAppBarTitle';
import { MaterialTopAppBar } from '../chrome/MaterialTopAppBar';
import type { ScrollEdgeBackdrop } from '../../hooks/use-scroll-edge-backdrop';
import { FeedScopeTitle } from './FeedScopeTitle';

const ROW_GUTTER = spacing[4];
// The floating avatar island's vertical band (matches the other tabs' chrome row):
// used to size the top blur and seed the host's list inset before the real height
// is measured.
export const TOP_ISLAND_BAND = spacing[1] + TOP_ACTION_SIZE + spacing[2];

export type HomeTopChromeProps = {
  /**
   * False when Home shows neither the feed nor Climbing now: there is nothing
   * to scope, so `scopeTitle` ("Home") shows as a plain title and the actions
   * are ignored. The header buttons stay either way.
   */
  showScopeMenu: boolean;
  /** The active feed scope, shown as the title-menu. */
  scopeTitle: string;
  /** Scope menu rows, in render order. */
  scopeActions: AppMenuAction[];
  onSelectScopeIndex: (index: number) => void;
  /** Open the full-screen climber search (the find-climbers action). */
  onOpenSearch: () => void;
  /** VoiceOver label for the find-climbers action. */
  searchAccessibilityLabel: string;
  /** VoiceOver hint for the scope title-menu. */
  scopeAccessibilityHint?: string;
  /** Report the measured chrome height so the feed insets its top padding. */
  onHeightChange: (height: number) => void;
  /** The feed under the bar, so the Material app bar tints once it scrolls under. */
  scrollEdge?: ScrollEdgeBackdrop;
};

export const HomeTopChrome = createVariantComponent('HomeTopChrome', {
  liquidGlass: HomeTopChromeGlass,
  material: HomeTopChromeMaterial,
});

function HomeTopChromeGlass({
  showScopeMenu,
  scopeTitle,
  scopeActions,
  onSelectScopeIndex,
  onOpenSearch,
  searchAccessibilityLabel,
  scopeAccessibilityHint,
  onHeightChange,
}: HomeTopChromeProps) {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const nativeHeader = useNativeRootHeader();

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange(event.nativeEvent.layout.height),
    [onHeightChange],
  );

  const handleOpenNotifications = useCallback(() => router.push('/(tabs)/home/notifications'), [router]);

  if (nativeHeader)
    return (
      <NativeRootHeader
        onHeightChange={onHeightChange}
        leftActionsStandalone
        leftActions={
          <GlassActionToolbar actionCount={1}>
            <UserAvatarToolbarAction variant="glass" />
          </GlassActionToolbar>
        }
        rightActions={
          <GlassActionToolbar actionCount={2}>
            <NotificationsToolbarAction variant="glass" onPress={handleOpenNotifications} />
            <GlassToolbarAction onPress={onOpenSearch} accessibilityLabel={searchAccessibilityLabel}>
              <Icon
                name="person.badge.plus"
                size={toolbarGlyphSize(22, NATIVE_ACTION_SIZE)}
                color={systemColors.label}
              />
            </GlassToolbarAction>
          </GlassActionToolbar>
        }
      />
    );

  return (
    <>
      {/* Frost content scrolling under the chrome band, matching the other tabs. */}
      <ProgressiveBlur style={[styles.topBlur, { height: insets.top + TOP_ISLAND_BAND }]} />
      {/* Floating header: the user-avatar island (left) and the scope menu (a glass
          title-menu pill, centred) over the blur — matching the other tabs.
          Deliberately box-none (unlike the opaque Material band below): the glass
          islands float over scrollable content, and the gaps between them must keep
          passing touches through. The islands themselves carry backgrounds, so
          RNGH's Android hit-test still targets them. */}
      <View
        pointerEvents="box-none"
        style={[styles.headerChrome, { paddingTop: insets.top + spacing[1] }]}
        onLayout={handleLayout}
      >
        <View pointerEvents="box-none" style={styles.headerRow}>
          <GlassActionToolbar actionCount={1}>
            <UserAvatarToolbarAction variant="glass" />
          </GlassActionToolbar>
          <View pointerEvents="box-none" style={styles.headerCenter}>
            {showScopeMenu ? (
              <FeedScopeTitle
                title={scopeTitle}
                actions={scopeActions}
                onSelectIndex={onSelectScopeIndex}
                accessibilityHint={scopeAccessibilityHint}
              />
            ) : (
              <Text variant="headline" numberOfLines={1} accessibilityRole="header">
                {scopeTitle}
              </Text>
            )}
          </View>
          {/* Trailing island, two slots wide (the island sizes itself from
              actionCount): the notifications bell, then find-climbers. It now
              outweighs the single avatar island on the left, so the centred scope
              pill sits a slot's width (TOP_ACTION_SIZE) left of true centre.
              Find-climbers uses a person-add glyph (not a magnifier) so it doesn't
              read as a second "search" next to the Climbs tab's bottom-bar one. */}
          <GlassActionToolbar actionCount={2}>
            <NotificationsToolbarAction variant="glass" onPress={handleOpenNotifications} />
            <GlassToolbarAction onPress={onOpenSearch} accessibilityLabel={searchAccessibilityLabel}>
              <Icon maxFontSizeMultiplier={1} name="person.badge.plus" size={22} color={systemColors.label} />
            </GlassToolbarAction>
          </GlassActionToolbar>
        </View>
      </View>
    </>
  );
}

function HomeTopChromeMaterial({
  showScopeMenu,
  scopeTitle,
  scopeActions,
  onSelectScopeIndex,
  onOpenSearch,
  searchAccessibilityLabel,
  scopeAccessibilityHint,
  onHeightChange,
  scrollEdge,
}: HomeTopChromeProps) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const router = useRouter();
  const homeTitle = t('mobile.nav.home');

  const handleOpenNotifications = useCallback(() => router.push('/(tabs)/home/notifications'), [router]);

  return (
    <MaterialTopAppBar onHeightChange={onHeightChange} scrollEdge={scrollEdge}>
      <UserAvatarToolbarAction variant="material" />
      {showScopeMenu ? (
        <>
          <FeedScopeTitle
            headline={homeTitle}
            title={scopeTitle}
            actions={scopeActions}
            onSelectIndex={onSelectScopeIndex}
            accessibilityHint={scopeAccessibilityHint}
          />
          {/* Flex spacer holds the actions to the trailing edge — the title-menu is a
              native menu anchor that hugs its content, so it can't flex into the slot
              the way `MaterialAppBarTitle` does. */}
          <View style={styles.materialSpacer} />
        </>
      ) : (
        <MaterialAppBarTitle title={homeTitle} />
      )}
      <NotificationsToolbarAction variant="material" onPress={handleOpenNotifications} />
      <Appbar.Action
        icon={iconMap['person.badge.plus'].android}
        color={systemColors.label as string}
        onPress={onOpenSearch}
        accessibilityLabel={searchAccessibilityLabel}
      />
    </MaterialTopAppBar>
  );
}

const styles = StyleSheet.create({
  // Progressive blur layer (height applied inline): spans from the top of the screen
  // down to just below the islands row, behind the islands.
  topBlur: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  headerChrome: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    // Pad the band's bottom so the measured height matches `insets.top +
    // TOP_ISLAND_BAND` (the value the host seeds the list inset with).
    paddingBottom: spacing[2],
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: ROW_GUTTER,
    height: TOP_ACTION_SIZE,
  },
  headerCenter: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[2],
  },
  // Pushes the find-climbers action to the trailing edge (the scope title-menu can't
  // flex, so the spacer takes the slack instead).
  materialSpacer: {
    flex: 1,
  },
});
