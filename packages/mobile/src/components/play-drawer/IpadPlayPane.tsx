import { memo } from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { useSegments } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PlayDrawer } from './PlayDrawer';
import { PanePlaceholder } from './PanePlaceholder';
import { WallStrip } from '../board-presence/WallStrip';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { resolveEffectiveWallSurface } from '../../theme/size-class';
import { tabsActiveSegment } from '../../lib/route-segments';
import { SIDEBAR_WIDTH } from '../../theme/layout';
import { spacing } from '../../theme/tokens';

/**
 * The persistent right column on the iPad shell: the PlayDrawer for the user's
 * selected climb, rendered as a pane (not a bottom sheet). It follows selection
 * like the iPad master-detail pattern — tapping a list row updates it — so the
 * browse→inspect flow works on iPad. The live wall is shown elsewhere (the
 * sidebar footer cell, a column in landscape, and — here — a compact strip docked
 * atop the pane in portrait, where there's no room for a column). The pane also
 * annotates its own header with an "On the wall" chip when the selected climb is
 * the one physically lit (see PlayDrawer's pane header). The drawer props come
 * from DrawerHostProvider so the pane and the compact bottom sheet stay identical;
 * the sheet is not mounted at regular width (see drawer-host-provider).
 */
function IpadPlayPaneComponent() {
  const { playDrawerPaneProps } = useDrawerHost();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation('session');
  const { width } = useWindowDimensions();
  const { widthClass, wallDeviceClass } = useDeviceLayout();
  const { enabled, boardId } = useBoardPresenceControls();
  const onWallTab = tabsActiveSegment(useSegments()) === 'wall';

  // In portrait/narrow regular there's no room for a wall column, so the wall
  // lives as a strip atop the pane. It shows only when board presence is active,
  // the device is large enough for the panel at all (sheet-only devices collapse
  // it — same gate the shell uses), and the "On the Wall" tab isn't already the
  // focused destination. When it shows, the strip owns the top inset (PlayDrawer
  // skips it).
  const wallSurface = resolveEffectiveWallSurface({ width, widthClass, wallDeviceClass, sidebarWidth: SIDEBAR_WIDTH });
  const showStrip = wallSurface === 'strip' && enabled && boardId !== null && !onWallTab;

  // No board resolved yet — the pane has no selection to show.
  if (!playDrawerPaneProps) {
    return (
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
      <PlayDrawer presentation="pane" {...playDrawerPaneProps} paneTopInset={!showStrip} />
    </View>
  );
}

export const IpadPlayPane = memo(IpadPlayPaneComponent);

const styles = StyleSheet.create({
  paneRoot: { flex: 1 },
});
