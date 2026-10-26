import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useIsFocused, useSegments } from 'expo-router';
import { useTheme } from '../../providers/theme-provider';
import { useNativeRootHeader } from '../../hooks/use-native-root-header';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import { usePhoneSplit } from '../../hooks/use-phone-split';
import { publishNativeTabletContentWidth, useTabletPaneWidth } from '../../hooks/native-tablet-pane-width';
import { useBoardPresenceControls } from '../../providers/board-presence-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useHingePartiallyOpen } from '../../lib/device-hinge-store';
import {
  resolveEffectiveWallSurface,
  resolveDetailPaneSurface,
  resolveDetailPaneWidth,
  resolvePhoneSplitColumns,
  WALL_COLUMN_WIDTH,
} from '../../theme/size-class';
import { tabsActiveSegment } from '../../lib/route-segments';
import { IpadPlayPane } from '../play-drawer/IpadPlayPane';
import { IpadWallColumn } from '../board-presence/IpadWallColumn';
import { HingeObserver } from './HingeObserver';

/**
 * Keep content panes inside UIKit's sidebar, where their actual width is known.
 * On iPad that is the tablet shell's panes; on iPhone it is the phone split (the
 * iPhone Duo opened in landscape), which can come and go with every fold, so the
 * iPhone always renders its host and only the pane mounts and unmounts. Swapping
 * the wrapper in and out would remount the tab's stack and lose its screens.
 */
export function NativeTabletContent({ children }: { children: ReactNode }) {
  const nativeRootHeader = useNativeRootHeader();
  if (!(nativeRootHeader && Platform.OS === 'ios')) return children;
  if (Platform.isPad === true) return <NativeTabletContentHost>{children}</NativeTabletContentHost>;
  return <PhoneSplitContentHost>{children}</PhoneSplitContentHost>;
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

/**
 * The iPhone host. Closed, portrait, and every ordinary iPhone: the tab content
 * fills it exactly as before (the insets context below passes the same object
 * through, so nothing downstream re-renders). In the phone split the content
 * keeps the leading half up to the hinge and the player pane takes the trailing
 * half beside the vertical tab rail.
 *
 * Safe areas: in landscape the rail and the side status bar arrive as a right
 * inset (84pt on the Duo). The pane pads by it so ⋯ and the grade clear them,
 * and hands its subtree insets with the sides zeroed so nothing inside pads
 * again; the content column sits away from the rail, so its right inset is zero.
 */
function PhoneSplitContentHost({ children }: { children: ReactNode }) {
  const phoneSplit = usePhoneSplit();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const partiallyFolded = useHingePartiallyOpen();
  const { contentWidth, foldInset } = resolvePhoneSplitColumns({ windowWidth, partiallyFolded });
  const contentInsets = useMemo(() => (phoneSplit ? { ...insets, right: 0 } : insets), [phoneSplit, insets]);
  return (
    <View style={styles.host}>
      {/* The same View either way (only its style changes), so entering or
          leaving the split never remounts the tab's stack. */}
      <View style={phoneSplit ? { width: contentWidth - foldInset } : styles.content}>
        <SafeAreaInsetsContext.Provider value={contentInsets}>{children}</SafeAreaInsetsContext.Provider>
      </View>
      {phoneSplit ? <PhoneSplitPane foldInset={foldInset} /> : null}
    </View>
  );
}

/**
 * The player half of the phone split: a fold gutter (zero wide unless the Duo is
 * half open) and the pane. Mounted only while the split is on. The hinge
 * observer lives here because the gutter only matters while there is a split to
 * keep off the crease; with no observer mounted the store keeps its last value,
 * which the next split's observer replaces as soon as it appears.
 */
function PhoneSplitPane({ foldInset }: { foldInset: number }) {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  // Only the focused tab's pane takes over the full-screen player's scroll
  // position; the other visited tabs' panes mount in the same commit.
  const isFocused = useIsFocused();
  const paneInsets = useMemo(() => ({ ...insets, left: 0, right: 0 }), [insets]);
  return (
    <>
      <View style={{ width: foldInset * 2 }} />
      <View
        style={[
          styles.splitPane,
          {
            paddingRight: insets.right,
            // Half open, the fold itself divides the halves; flat, a hairline does.
            borderLeftWidth: foldInset > 0 ? 0 : StyleSheet.hairlineWidth,
            borderLeftColor: systemColors.separator,
          },
        ]}
      >
        <SafeAreaInsetsContext.Provider value={paneInsets}>
          <IpadPlayPane variant="phoneSplit" acceptsScrollHandoff={isFocused} />
        </SafeAreaInsetsContext.Provider>
        <HingeObserver />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1, flexDirection: 'row' },
  content: { flex: 1, minWidth: 0 },
  pane: { height: '100%', borderLeftWidth: StyleSheet.hairlineWidth },
  splitPane: { flex: 1, minWidth: 0 },
});
