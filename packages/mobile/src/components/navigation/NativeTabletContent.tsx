import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useFocusEffect, useSegments } from 'expo-router';
import { useTheme } from '../../providers/theme-provider';
import { useNativeRootHeader } from '../../hooks/use-native-root-header';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { publishNativeTabletContentWidth, useTabletPaneWidth } from '../../hooks/native-tablet-pane-width';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import {
  resolveEffectiveWallSurface,
  resolveDetailPaneSurface,
  resolveDetailPaneWidth,
  WALL_COLUMN_WIDTH,
} from '../../theme/size-class';
import { tabsActiveSegment } from '../../lib/route-segments';
import { IpadPlayPane } from '../play-drawer/IpadPlayPane';
import { IpadWallColumn } from '../board-presence/IpadWallColumn';

/** Keep content panes inside UIKit's sidebar, where their actual width is known. */
export function NativeTabletContent({ children }: { children: ReactNode }) {
  const nativeRootHeader = useNativeRootHeader();
  if (!(nativeRootHeader && Platform.OS === 'ios' && Platform.isPad === true)) return children;
  return <NativeTabletContentHost>{children}</NativeTabletContentHost>;
}

function NativeTabletContentHost({ children }: { children: ReactNode }) {
  const { systemColors } = useTheme();
  const { widthClass, wallDeviceClass } = useDeviceLayout();
  const { width, sidebarWidth } = useTabletPaneWidth();
  const [hostWidth, setHostWidth] = useState(0);
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  useEffect(() => {
    if (focused) publishNativeTabletContentWidth(hostWidth);
  }, [focused, hostWidth]);
  const measureHost = useCallback((event: LayoutChangeEvent) => setHostWidth(event.nativeEvent.layout.width), []);
  const segments = useSegments();
  const onWallTab = tabsActiveSegment(segments) === 'wall';
  const { enabled, boardId } = useBoardPresenceControls();
  const { data: activeBoard } = useActiveBoard();
  const wallSurface = resolveEffectiveWallSurface({ width, widthClass, wallDeviceClass, sidebarWidth });
  const showWall = !onWallTab && wallSurface === 'column' && enabled && boardId !== null && activeBoard != null;
  const showDetail = !onWallTab && resolveDetailPaneSurface({ width, widthClass, sidebarWidth }) === 'pane';
  const paneWidth = resolveDetailPaneWidth({ width, sidebarWidth, wallColumnVisible: showWall });
  return (
    <View onLayout={measureHost} style={styles.host}>
      <View style={styles.content}>{children}</View>
      {showDetail ? (
        <View style={[styles.pane, { width: paneWidth, borderLeftColor: systemColors.separator }]}>
          <IpadPlayPane />
        </View>
      ) : null}
      {showWall ? (
        <View style={[styles.pane, { width: WALL_COLUMN_WIDTH, borderLeftColor: systemColors.separator }]}>
          <IpadWallColumn />
        </View>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  host: { flex: 1, flexDirection: 'row' },
  content: { flex: 1, minWidth: 0 },
  pane: { height: '100%', borderLeftWidth: StyleSheet.hairlineWidth },
});
