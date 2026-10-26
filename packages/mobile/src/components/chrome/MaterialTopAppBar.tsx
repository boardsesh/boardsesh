import { type ReactNode, useCallback, useEffect } from 'react';
import { type LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Appbar } from 'react-native-paper';
import { useTheme } from '../../providers/theme-provider';
import { type ScrollEdgeBackdrop, useScrolledUnder } from '../../hooks/use-scroll-edge-backdrop';

type MaterialTopAppBarProps = {
  /** The bar row: the leading avatar, a `MaterialAppBarTitle` (or a title-menu) and the actions. */
  children: ReactNode;
  /** Rows drawn under the bar inside the same band (Profile's tabs, the Climbs search row). */
  below?: ReactNode;
  /** Report the measured band height so the list can inset its top padding. */
  onHeightChange: (height: number) => void;
  /**
   * The list under the band. The band is `surface` while the list rests at its
   * top and `surfaceContainer` once rows scroll under it. Without one the band
   * stays flat.
   */
  scrollEdge?: ScrollEdgeBackdrop;
  testID?: string;
};

/**
 * The one Material small top app bar every root tab draws, so the leading avatar
 * and the title start at the same inset on every tab. Absolutely positioned: the
 * list scrolls under it and insets itself by the reported height.
 *
 * M3 top app bar spec: the container is `surface` at rest and `surfaceContainer`
 * once content scrolls under it, with no divider. Paper's own elevation is off
 * because the band, not the Appbar, owns the colour.
 */
export function MaterialTopAppBar({ children, below, onHeightChange, scrollEdge, testID }: MaterialTopAppBarProps) {
  const { systemColors, m3SurfaceContainers } = useTheme();
  const insets = useSafeAreaInsets();
  const scrolledUnder = useScrolledUnder(scrollEdge);
  // `useScrolledUnder` answers yes when there is no store; a band never wired to
  // a list should read as at rest instead.
  const tinted = scrollEdge != null && scrolledUnder;

  // Attaching is what makes the screen hand its list the scroll listeners.
  useEffect(() => scrollEdge?.attachBackdrop(), [scrollEdge]);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onHeightChange(event.nativeEvent.layout.height),
    [onHeightChange],
  );

  return (
    <View
      // NOT box-none: the opaque band must swallow every touch in its bounds.
      // RNGH's Android hit-test sees straight through handler-less,
      // background-less subtrees (box-none skips its background check), so
      // list-row Gesture.Tap handlers underneath would steal taps on the bar's
      // controls once the list has scrolled under it. With `auto`, the band's
      // background makes it the RNGH touch target. Inner wrappers can stay
      // box-none: only RN's own hit-testing runs inside once this claims the pointer.
      pointerEvents="auto"
      testID={testID}
      style={[
        styles.band,
        {
          paddingTop: insets.top,
          backgroundColor: tinted ? m3SurfaceContainers.base : systemColors.background,
        },
      ]}
      onLayout={handleLayout}
    >
      <Appbar.Header statusBarHeight={0} mode="small" elevated={false} style={styles.appbar}>
        {children}
      </Appbar.Header>
      {below}
    </View>
  );
}

const styles = StyleSheet.create({
  band: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
  },
  appbar: {
    backgroundColor: 'transparent',
    elevation: 0,
    shadowOpacity: 0,
  },
});
