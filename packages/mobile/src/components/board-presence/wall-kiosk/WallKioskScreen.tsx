import { memo, useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BoardName } from '@boardsesh/shared-schema';
import { useBoardClimbRecentSenders } from '@boardsesh/board-presence-react';
import { getBoardRenderData } from '../../../lib/board-details';
import { parseSetIds } from '../../../lib/board-presence/parse-set-ids';
import { useTheme } from '../../../providers/theme-provider';
import type { BoardConfig } from '../../../providers/drawer-host-provider';
import { WallEmptyState } from '../WallEmptyState';
import { useWallKioskLayout } from './useWallKioskLayout';
import { useWallPreview } from './useWallPreview';
import { WallHeroStage } from './WallHeroStage';
import { WallChromeRegion } from './WallChromeRegion';
import type { WallStateMode } from './WallStateStrip';
import { shouldFetchRecentSenders } from './wall-kiosk-layout';

/**
 * The wall-mounted kiosk surface. The board is a SIBLING flex region (never an
 * absolute child, never overlapped) docked flush to a single always-reserved
 * off-board chrome region — a trailing RAIL (landscape) or a bottom BAND
 * (portrait). Dead letterbox pools on the board's far edge via the flex
 * alignment. Live / preview / idle all drive off `useWallPreview`; the board just
 * renders whichever climb's holds, undimmed.
 */
function WallKioskScreenComponent({ boardConfig }: { boardConfig: BoardConfig }) {
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();

  const renderData = useMemo(() => {
    const setIds = parseSetIds(boardConfig.setIds);
    if (setIds.length === 0) return null;
    return getBoardRenderData({
      boardName: boardConfig.boardName as BoardName,
      layoutId: boardConfig.layoutId,
      sizeId: boardConfig.sizeId,
      setIds,
    });
  }, [boardConfig]);

  const aspectRatio = renderData ? renderData.boardWidth / renderData.boardHeight : null;
  const { onLayout, layout, typeScale } = useWallKioskLayout(aspectRatio);
  const preview = useWallPreview();

  const mode: WallStateMode = preview.isPreviewing ? 'history' : preview.liveClimb ? 'live' : 'idle';
  const { senders: recentSenders } = useBoardClimbRecentSenders({
    climbUuid: preview.displayedClimb?.climbUuid,
    angle: preview.displayedClimb?.angle,
    enabled: shouldFetchRecentSenders(layout, mode),
  });

  let content: ReactNode = null;
  if (!renderData) {
    content = <WallEmptyState />;
  } else if (layout) {
    const { region, boardRect, chromeRect, gap } = layout;
    const board = (
      <WallHeroStage
        climb={preview.displayedClimb}
        boardConfig={boardConfig}
        boardWidth={renderData.boardWidth}
        boardHeight={renderData.boardHeight}
        artWidth={boardRect.width}
        artHeight={boardRect.height}
      />
    );
    const chrome = (
      <WallChromeRegion
        region={region}
        mode={mode}
        preview={preview}
        typeScale={typeScale}
        bandWidth={chromeRect.width}
        compact={layout.compact}
        recentSenders={recentSenders}
      />
    );

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
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
      ]}
    >
      {content}
    </View>
  );
}

export const WallKioskScreen = memo(WallKioskScreenComponent);

const styles = StyleSheet.create({
  root: { flex: 1 },
  row: { flex: 1, flexDirection: 'row' },
  col: { flex: 1, flexDirection: 'column' },
  // Board docks flush to the chrome (right in a rail / bottom in a band); the dead
  // letterbox pools on the far edge, and the board centers on the perpendicular axis.
  boardRegionRail: { flex: 1, alignItems: 'flex-end', justifyContent: 'center' },
  boardRegionBand: { flex: 1, alignItems: 'center', justifyContent: 'flex-end' },
});
