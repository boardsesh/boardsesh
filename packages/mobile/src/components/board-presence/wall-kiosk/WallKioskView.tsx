import { memo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../../providers/theme-provider';
import { useWallKioskLayout } from './useWallKioskLayout';
import type { WallKioskRegion } from './wall-kiosk-layout';
import type { WallKioskTypeScale } from './wall-kiosk-type';
export type WallKioskViewProps = {
  renderData: { boardWidth: number; boardHeight: number } | null;
  renderBoard: (width: number, height: number) => ReactNode;
  renderChrome: (layout: { region: WallKioskRegion; typeScale: WallKioskTypeScale; bandWidth: number }) => ReactNode;
  emptyState: ReactNode;
};
export const WallKioskView = memo(function WallKioskView({
  renderData,
  renderBoard,
  renderChrome,
  emptyState,
}: WallKioskViewProps) {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const aspectRatio = renderData ? renderData.boardWidth / renderData.boardHeight : null;
  const { onLayout, layout, typeScale } = useWallKioskLayout(aspectRatio);

  let content: ReactNode = null;
  if (!renderData) {
    content = emptyState;
  } else if (layout) {
    const { region, boardRect, chromeRect, gap } = layout;
    const board = renderBoard(boardRect.width, boardRect.height);
    const chrome = renderChrome({ region, typeScale, bandWidth: chromeRect.width });

    content =
      region === 'rail' ? (
        <View style={styles.row}>
          <View style={styles.boardRegionRail}>{board}</View>
          <View style={{ width: gap }} />
          {/* Chrome constrained to the resolved rect (not stretched to full pane
              height) and centered on the board's axis. */}
          <View style={{ width: chromeRect.width, height: chromeRect.height, alignSelf: 'center' }}>{chrome}</View>
        </View>
      ) : (
        <View style={styles.col}>
          <View style={styles.boardRegionBand}>{board}</View>
          <View style={{ height: gap }} />
          <View style={{ height: chromeRect.height }}>{chrome}</View>
        </View>
      );
  }

  return (
    <View
      onLayout={onLayout}
      style={[
        styles.root,
        {
          backgroundColor: systemColors.background,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingStart: insets.left,
          paddingEnd: insets.right,
        },
      ]}
    >
      {content}
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  row: { flex: 1, flexDirection: 'row' },
  col: { flex: 1, flexDirection: 'column' },
  // Board docks flush to the chrome (right in a rail / bottom in a band); the dead
  // letterbox pools on the far edge, and the board centers on the perpendicular axis.
  boardRegionRail: { flex: 1, alignItems: 'flex-end', justifyContent: 'center' },
  boardRegionBand: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
});
