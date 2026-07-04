import { memo, useCallback, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { NowOnTheWallPanel } from './NowOnTheWallPanel';
import { WallFocalClimb } from './WallFocalClimb';
import { WallEmptyState } from './WallEmptyState';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useTheme } from '../../providers/theme-provider';
import { REGULAR_WIDTH_BREAKPOINT } from '../../theme/size-class';

/**
 * The "On the Wall" tab body. iPad-only destination (routed from the sidebar), so
 * it always renders inside the regular-width shell content pane. Its layout is
 * driven by its OWN measured width (not the window, which is wider than the
 * content pane, and not an orientation API): at/above the regular breakpoint it
 * splits into a leading focal pane (the lit climb) + a trailing scrolling list
 * (stats + "This session" leaderboard + history); below it — a narrow Split View
 * window, or the content pane once the play pane takes its share — it falls back
 * to the single-column composition so nothing gets crushed.
 *
 * The wall is live only when a board is bound over Bluetooth, matching
 * `SidebarWallCell` and the shell column. `boardPanelProps` is non-null whenever a
 * board is merely stored, so the empty state gates on the presence controls.
 */
function WallScreenComponent() {
  const { systemColors } = useTheme();
  const { boardPanelProps } = useDrawerHost();
  const { enabled, boardId } = useBoardPresenceControls();

  const [containerWidth, setContainerWidth] = useState(0);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setContainerWidth((prev) => (prev === nextWidth ? prev : nextWidth));
  }, []);

  const isWallLive = enabled && boardId !== null;
  const twoPane = containerWidth >= REGULAR_WIDTH_BREAKPOINT;

  return (
    <View style={[styles.root, { backgroundColor: systemColors.background }]} onLayout={handleLayout}>
      {!isWallLive || !boardPanelProps ? (
        <WallEmptyState />
      ) : twoPane ? (
        <View style={styles.row}>
          <View style={[styles.focal, { borderRightColor: systemColors.separator }]}>
            <WallFocalClimb boardConfig={boardPanelProps.boardConfig} />
          </View>
          <View style={styles.list}>
            <NowOnTheWallPanel variant="screen" showHero={false} {...boardPanelProps} />
          </View>
        </View>
      ) : (
        <NowOnTheWallPanel variant="screen" {...boardPanelProps} />
      )}
    </View>
  );
}

export const WallScreen = memo(WallScreenComponent);

const styles = StyleSheet.create({
  root: { flex: 1 },
  row: { flex: 1, flexDirection: 'row' },
  // The focal pane leads at ~48% but caps so the extra width on a 13" goes to the
  // readable list, not an oversized board (mirrors Apple Photos/Files).
  focal: {
    flexBasis: '48%',
    flexGrow: 0,
    flexShrink: 0,
    maxWidth: 520,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  list: { flex: 1 },
});
