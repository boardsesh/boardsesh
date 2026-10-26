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
import { PhoneSplitPaneSlotContext } from './phone-split-pane-slot';

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
 * fills it exactly as before. In the phone split the player pane takes the
 * leading half up to the hinge and the tab content the trailing half, beside the
 * vertical tab rail.
 *
 * The content View is always the second child (the pane slot before it is `null`
 * off the split) and never changes style, so entering or leaving the split never
 * remounts the tab's stack.
 *
 * Safe areas: in landscape the rail and the side status bar arrive as a right
 * inset (84pt on the Duo). The content column ends at the rail, so it keeps the
 * real insets and anything that pads by them (`useHorizontalSafeArea`, the
 * native header) stays right. The pane sits at the other edge: it pads by the
 * left inset (0 on the Duo) and hands its subtree side insets of zero, so nothing
 * inside it pads for a rail it never touches.
 */
function PhoneSplitContentHost({ children }: { children: ReactNode }) {
  const phoneSplit = usePhoneSplit();
  // What a screen in this tab asked to show in the pane instead of the player
  // (`usePhoneSplitPaneContent`), e.g. the workout preview while one is built.
  const [paneContent, setPaneContent] = useState<ReactNode | null>(null);
  return (
    <View style={styles.host}>
      {phoneSplit ? <PhoneSplitPane content={paneContent} /> : null}
      <View style={styles.content}>
        <PhoneSplitPaneSlotContext.Provider value={setPaneContent}>{children}</PhoneSplitPaneSlotContext.Provider>
      </View>
    </View>
  );
}

/**
 * The leading half of the phone split: the pane, ending at the hinge, and a fold
 * gutter (zero wide unless the Duo is half open). Mounted only while the split
 * is on. It shows the player unless a screen in this tab handed it `content`.
 * The hinge status comes from the app's one observer (`PhoneSplitHingeObserver`,
 * at the root).
 */
function PhoneSplitPane({ content }: { content: ReactNode | null }) {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const partiallyFolded = useHingePartiallyOpen();
  const { leadingWidth, foldInset } = resolvePhoneSplitColumns({ windowWidth, partiallyFolded });
  // Only the focused tab's pane takes over the full-screen player's scroll
  // position; the other visited tabs' panes mount in the same commit.
  const isFocused = useIsFocused();
  const paneInsets = useMemo(() => ({ ...insets, left: 0, right: 0 }), [insets]);
  return (
    <>
      <View
        style={[
          styles.splitPane,
          {
            width: leadingWidth - foldInset,
            paddingLeft: insets.left,
            // Half open, the fold itself divides the halves; flat, a hairline on
            // the pane's hinge edge does.
            borderEndWidth: foldInset > 0 ? 0 : StyleSheet.hairlineWidth,
            borderEndColor: systemColors.separator,
          },
        ]}
      >
        <SafeAreaInsetsContext.Provider value={paneInsets}>
          {content ?? <IpadPlayPane variant="phoneSplit" acceptsScrollHandoff={isFocused} />}
        </SafeAreaInsetsContext.Provider>
      </View>
      <View style={{ width: foldInset * 2 }} />
    </>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1, flexDirection: 'row' },
  content: { flex: 1, minWidth: 0 },
  pane: { height: '100%', borderLeftWidth: StyleSheet.hairlineWidth },
  splitPane: { minWidth: 0 },
});
