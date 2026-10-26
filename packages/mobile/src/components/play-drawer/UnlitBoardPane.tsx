import { memo, useCallback, useMemo, useState } from 'react';
import { PixelRatio, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BoardName } from '@boardsesh/shared-schema';
import { BoardImageNative } from '../BoardImageNative';
import { useChromeIconButtonSize } from '../ChromeIconButton';
import { Text } from '../Text';
import { getBoardRenderData } from '../../lib/board-details';
import { parseSetIds } from '../../lib/board-presence/parse-set-ids';
import { useSprayWallToken } from '../../lib/spray/use-spray-wall-token';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { computeContainedBoardSize } from './play-drawer-layout';
import type { BoardConfig } from './play-drawer-types';

// The split player's first screen around the board (fit to the pane's height,
// see computeFitToHeightFirstScreenHeight), approximated so the board sits where
// the player will draw it and opening a climb only lights holds. The header row
// (avatar, name, grade) is where the hint goes; the tick row stays empty below,
// and everything after it is below the fold.
const HEADER_HEIGHT_ESTIMATE = 64;
const TICK_ROW_HEIGHT_ESTIMATE = 72;

type BoardBox = { width: number; height: number };

/**
 * The phone split's empty player: the active board drawn unlit with "Tap a
 * climb to light it" where the climb's name will be. The pane stays on screen
 * with nothing playing, so the split never reflows when the first climb opens;
 * the holds just light up. Passed to PlayDrawer as `paneEmptyState`.
 */
function UnlitBoardPaneComponent({ boardConfig, paneTopInset }: { boardConfig: BoardConfig; paneTopInset: boolean }) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const insets = useSafeAreaInsets();
  const topRowHeight = useChromeIconButtonSize();
  const sprayToken = useSprayWallToken(boardConfig.boardName, boardConfig.layoutId);
  const renderData = useMemo(() => {
    const setIds = parseSetIds(boardConfig.setIds);
    if (setIds.length === 0) return null;
    return getBoardRenderData({
      boardName: boardConfig.boardName as BoardName,
      layoutId: boardConfig.layoutId,
      sizeId: boardConfig.sizeId,
      setIds,
    });
    // `sprayToken` recomputes this when a spray wall lands or is reset.
  }, [boardConfig, sprayToken]);

  const [boardArea, setBoardArea] = useState<BoardBox | null>(null);
  const handleBoardAreaLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBoardArea((current) =>
      current && current.width === width && current.height === height ? current : { width, height },
    );
  }, []);
  const boardBox =
    boardArea && renderData
      ? computeContainedBoardSize(boardArea.width, boardArea.height, renderData.boardWidth / renderData.boardHeight)
      : null;

  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: (paneTopInset ? insets.top : 0) + spacing[2],
          paddingBottom: insets.bottom,
        },
      ]}
    >
      <View style={{ height: topRowHeight }} />
      <View style={styles.header}>
        <Text variant="headline" color={systemColors.secondaryLabel} style={styles.hint}>
          {t('playView.paneEmpty.unlitHint')}
        </Text>
      </View>
      <View style={styles.boardArea} onLayout={handleBoardAreaLayout}>
        {boardBox && renderData ? (
          <BoardImageNative
            accessible={false}
            frames=""
            boardName={boardConfig.boardName as BoardName}
            layoutId={boardConfig.layoutId}
            sizeId={boardConfig.sizeId}
            setIds={boardConfig.setIds}
            boardWidth={renderData.boardWidth}
            boardHeight={renderData.boardHeight}
            renderWidth={Math.round(boardBox.width * PixelRatio.get())}
            backgroundVariant="full"
            style={boardBox}
          />
        ) : null}
      </View>
      <View style={styles.controls} />
    </View>
  );
}

export const UnlitBoardPane = memo(UnlitBoardPaneComponent);

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    height: HEADER_HEIGHT_ESTIMATE,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[4],
  },
  hint: { textAlign: 'center' },
  boardArea: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  controls: { height: TICK_ROW_HEIGHT_ESTIMATE },
});
