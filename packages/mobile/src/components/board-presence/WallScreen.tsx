import { memo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { WallEmptyState } from './WallEmptyState';
import { WallKioskScreen } from './wall-kiosk/WallKioskScreen';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useTheme } from '../../providers/theme-provider';

/**
 * The "On the Wall" tab body — a wall-mounted iPad KIOSK. Its job is to DISPLAY
 * what climb is currently lit on the physical wall, big and glanceable from across
 * a gym, and to step back/forward through the wall's own history to restore an
 * accidental change (preview-then-confirm). It is NOT a search/driving surface —
 * that's the climber's phone or the Climbs tab.
 *
 * The wall is live only when a board is bound over Bluetooth. When it is,
 * `WallKioskScreen` owns the responsive layout (the board art dominates, secondary
 * chrome fills whatever gutter the board's aspect ratio leaves). When it isn't,
 * the empty state prompts a connect. `boardPanelProps` is non-null whenever a
 * board's config is resolved; while it's still resolving we render a neutral
 * themed blank, never the "Connect a board" CTA (wrong for someone who just
 * connected).
 */
function WallScreenComponent() {
  const { systemColors } = useTheme();
  const { boardPanelProps } = useDrawerHost();
  const { enabled, boardId } = useBoardPresenceControls();

  const isWallLive = enabled && boardId !== null;

  let content: ReactNode;
  if (!isWallLive) {
    content = <WallEmptyState />;
  } else if (!boardPanelProps?.boardConfig) {
    // Bound over Bluetooth, but the active board config hasn't resolved yet — a
    // neutral themed blank, never the "Connect a board" CTA.
    content = null;
  } else {
    content = <WallKioskScreen boardConfig={boardPanelProps.boardConfig} />;
  }

  return <View style={[styles.root, { backgroundColor: systemColors.background }]}>{content}</View>;
}

export const WallScreen = memo(WallScreenComponent);

const styles = StyleSheet.create({
  root: { flex: 1 },
});
