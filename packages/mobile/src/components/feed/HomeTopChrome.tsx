// Top chrome for the Home (feed) tab, routed by UI variant.
//
// Liquid Glass: the floating chrome shared with the other tabs — an always-on
// progressive blur plus a row of glass islands (account avatar left, the
// `FeedScopeTitle` title-menu pill centred, a find-climbers action right). The feed
// scrolls under the blur.
//
// Material: an absolutely-positioned, `onHeightChange`-measured M3 small app bar
// (mirroring `ProfileTopChrome` / `ClimbTopChrome`) — the account avatar, the
// `FeedScopeTitle` as the flat app-bar title-menu, and the find-climbers
// `Appbar.Action`. Home has no board/angle/light controls and no create action, so
// the bar stays avatar · scope · find-climbers.

import { useCallback } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Appbar } from 'react-native-paper';
import { useTheme } from '../../providers/theme-provider';
import { createVariantComponent } from '../../theme/variants';
import { spacing } from '../../theme/tokens';
import { Icon } from '../Icon';
import { iconMap } from '../icon-map';
import { type AppMenuAction } from '../AppMenu';
import { ProgressiveBlur } from '../ProgressiveBlur';
import { GlassActionToolbar, GlassToolbarAction, TOP_ACTION_SIZE } from '../chrome';
import { UserAvatarToolbarAction } from '../user-drawer/UserAvatarToolbarAction';
import { FeedScopeTitle } from './FeedScopeTitle';

const ROW_GUTTER = spacing[4];
// The floating avatar island's vertical band (matches the other tabs' chrome row):
// used to size the top blur and seed the host's list inset before the real height
// is measured.
export const TOP_ISLAND_BAND = spacing[1] + TOP_ACTION_SIZE + spacing[2];

export type HomeTopChromeProps = {
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
};

export const HomeTopChrome = createVariantComponent('HomeTopChrome', {
  liquidGlass: HomeTopChromeGlass,
  material: HomeTopChromeMaterial,
});

function HomeTopChromeGlass({
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

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange(event.nativeEvent.layout.height),
    [onHeightChange],
  );

  return (
    <>
      {/* Frost content scrolling under the chrome band, matching the other tabs. */}
      <ProgressiveBlur style={[styles.topBlur, { height: insets.top + TOP_ISLAND_BAND }]} />
      {/* Floating header: the user-avatar island (left) and the scope menu (a glass
          title-menu pill, centred) over the blur — matching the other tabs. */}
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
            <FeedScopeTitle
              title={scopeTitle}
              actions={scopeActions}
              onSelectIndex={onSelectScopeIndex}
              accessibilityHint={scopeAccessibilityHint}
            />
          </View>
          {/* Find-climbers action: balances the avatar so the scope menu reads
              centred, and opens the full-screen climber search. Uses a person-add
              glyph (not a magnifier) so it doesn't read as a second "search" next to
              the Climbs tab's bottom-bar magnifier. */}
          <GlassActionToolbar actionCount={1}>
            <GlassToolbarAction onPress={onOpenSearch} accessibilityLabel={searchAccessibilityLabel}>
              <Icon name="person.badge.plus" size={22} color={systemColors.label} />
            </GlassToolbarAction>
          </GlassActionToolbar>
        </View>
      </View>
    </>
  );
}

function HomeTopChromeMaterial({
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

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange(event.nativeEvent.layout.height),
    [onHeightChange],
  );

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
        <FeedScopeTitle
          title={scopeTitle}
          actions={scopeActions}
          onSelectIndex={onSelectScopeIndex}
          accessibilityHint={scopeAccessibilityHint}
        />
        {/* Flex spacer holds the find-climbers action to the trailing edge — the
            scope title-menu is a Paper Menu (content-width anchor), so it can't flex
            into the slot itself the way Appbar.Content / BoardSwitcherButton do. */}
        <View style={styles.materialSpacer} />
        <Appbar.Action
          icon={iconMap['person.badge.plus'].android}
          color={systemColors.label as string}
          onPress={onOpenSearch}
          accessibilityLabel={searchAccessibilityLabel}
        />
      </Appbar.Header>
    </View>
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
  // Material small app bar (mirrors ProfileTopChrome / ClimbTopChrome): absolutely
  // positioned so the feed scrolls under it, height reported via onLayout.
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
  // Pushes the find-climbers action to the trailing edge (the scope title-menu can't
  // flex, so the spacer takes the slack instead).
  materialSpacer: {
    flex: 1,
  },
});
