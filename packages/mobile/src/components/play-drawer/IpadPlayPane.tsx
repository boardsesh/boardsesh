import { memo, useCallback, useMemo } from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { router, useSegments } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PlayDrawer } from './PlayDrawer';
import { PanePlaceholder } from './PanePlaceholder';
import { UnlitBoardPane } from './UnlitBoardPane';
import { WallStrip } from '../board-presence/WallStrip';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { resolveEffectiveWallSurface } from '../../theme/size-class';
import { SIDEBAR_WIDTH } from '../../theme/layout';
import { tabsActiveSegment } from '../../lib/route-segments';
import { NO_BOARD_PICKER_HREF } from '../../lib/boards/first-board-mode';
import { spacing } from '../../theme/tokens';

/**
 * The persistent right column on the JS tablet shell (Android tablets, Expo web, a
 * Material-variant iPad): the PlayDrawer for the user's selected climb, rendered
 * as a pane (not a bottom sheet). It follows selection like a master-detail pane:
 * tapping a list row updates it. The native iPad has no pane; like Music it opens
 * the full-screen player from the bottom accessory. The live wall is shown elsewhere (the
 * sidebar footer cell, a column in landscape, and — here — a compact strip docked
 * atop the pane in portrait, where there's no room for a column). The pane also
 * annotates its own header with an "On the wall" chip when the selected climb is
 * the one physically lit (see PlayDrawer's pane header). The drawer props come
 * from DrawerHostProvider so the pane and the compact bottom sheet stay identical;
 * the sheet is not mounted at regular width (see drawer-host-provider).
 *
 * `variant="phoneSplit"` is the same pane on the leading half of the phone split
 * (iPhone Duo open in landscape). There it is the current climb's home rather
 * than a selection's, so its empty states show the board unlit, or the board
 * picker when no board is chosen. The wall strip never shows there (a phone is
 * `sheet-only`).
 */
function IpadPlayPaneComponent({
  variant = 'tablet',
  acceptsScrollHandoff = false,
}: {
  variant?: 'tablet' | 'phoneSplit';
  acceptsScrollHandoff?: boolean;
}) {
  const { playDrawerPaneProps } = useDrawerHost();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation('session');
  const { t: tClimbs } = useTranslation('climbs');
  const { width } = useWindowDimensions();
  const { widthClass, wallDeviceClass } = useDeviceLayout();
  const { enabled, boardId } = useBoardPresenceControls();
  const segments = useSegments();
  const onWallTab = tabsActiveSegment(segments) === 'wall';
  const phoneSplit = variant === 'phoneSplit';
  // The picker's no-board entry, as on the Climbs tab's empty state: a climber
  // with no boards gets "Where do you climb?", one whose board was cleared gets
  // their list.
  const openBoardPicker = useCallback(() => router.push(NO_BOARD_PICKER_HREF), []);

  // In portrait/narrow regular there's no room for a wall column, so the wall
  // lives as a strip atop the pane. It shows only when board presence is active,
  // the device is large enough for the panel at all (sheet-only devices collapse
  // it — same gate the shell uses), and the "On the Wall" tab isn't already the
  // focused destination. When it shows, the strip owns the top inset (PlayDrawer
  // skips it).
  const wallSurface = resolveEffectiveWallSurface({
    width,
    widthClass,
    wallDeviceClass,
    sidebarWidth: SIDEBAR_WIDTH,
  });
  const showStrip = wallSurface === 'strip' && enabled && boardId !== null && !onWallTab;
  const paneBoardConfig = playDrawerPaneProps?.boardConfig;
  const paneEmptyState = useMemo(
    () =>
      phoneSplit && paneBoardConfig ? (
        <UnlitBoardPane boardConfig={paneBoardConfig} paneTopInset={!showStrip} />
      ) : undefined,
    [phoneSplit, paneBoardConfig, showStrip],
  );

  // No board resolved yet — the pane has no selection to show.
  if (!playDrawerPaneProps) {
    return phoneSplit ? (
      <PanePlaceholder
        icon="boards"
        title={tClimbs('mobile.emptyState.noBoard.title')}
        subtitle={tClimbs('mobile.emptyState.noBoard.subtitle')}
        actionTitle={tClimbs('mobile.emptyState.noBoard.cta')}
        onAction={openBoardPicker}
        paddingTop={insets.top + spacing[8]}
        paddingBottom={insets.bottom}
      />
    ) : (
      <PanePlaceholder
        title={t('playView.paneEmpty.title')}
        subtitle={t('playView.paneEmpty.subtitle')}
        paddingTop={insets.top + spacing[8]}
        paddingBottom={insets.bottom}
      />
    );
  }

  return (
    <View style={styles.paneRoot}>
      {showStrip ? <WallStrip /> : null}
      <PlayDrawer
        presentation="pane"
        {...playDrawerPaneProps}
        paneTopInset={!showStrip}
        paneEmptyState={paneEmptyState}
        acceptsScrollHandoff={acceptsScrollHandoff}
        fitBoardToPaneHeight={phoneSplit}
      />
    </View>
  );
}

export const IpadPlayPane = memo(IpadPlayPaneComponent);

const styles = StyleSheet.create({
  paneRoot: { flex: 1 },
});
