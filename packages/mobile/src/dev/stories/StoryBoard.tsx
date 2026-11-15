import { useCallback, useMemo, useState } from 'react';
import { View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import type { Climb } from '@boardsesh/shared-schema';
import { BoardImageNative } from '../../components/BoardImageNative';
import { getBoardRenderData } from '../../lib/board-details';
import { useStoryBoardRenderStyle } from '../fixtures/board-render-style';
import type { BoardArtReadiness } from '../../lib/board-render/ready-board-art';
import { STORY_BOARD } from '../fixtures/climbs';
import type { StoryBoardConfig } from '../fixtures/boards';
import type { StoryRenderControls } from './types';

/** Real bundled board art and renderer; no backend, board activation or device connection. */
export function StoryBoard({
  climb,
  board = STORY_BOARD,
  mirrored = false,
  onReady,
  onError,
}: { climb: Climb; board?: StoryBoardConfig; mirrored?: boolean } & StoryRenderControls) {
  const renderStyle = useStoryBoardRenderStyle();
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const renderData = useMemo(
    () => getBoardRenderData({ ...board, setIds: board.setIds.split(',').map(Number) }),
    [board],
  );
  const onLayout = useCallback(({ nativeEvent: { layout } }: LayoutChangeEvent) => {
    setBounds((previous) =>
      previous.width === layout.width && previous.height === layout.height
        ? previous
        : { width: layout.width, height: layout.height },
    );
  }, []);
  const onArtReadinessChange = useCallback(
    (readiness: BoardArtReadiness) => {
      if (readiness === 'ready') onReady();
      if (readiness === 'failed') onError(new Error('Story board art failed to render'));
    },
    [onReady, onError],
  );
  if (!renderData) throw new Error('Story board configuration has no bundled art');
  const scale = Math.min(bounds.width / renderData.boardWidth, bounds.height / renderData.boardHeight);
  const width = renderData.boardWidth * scale;
  const height = renderData.boardHeight * scale;
  return (
    <View onLayout={onLayout} style={styles.root}>
      {width > 0 && height > 0 ? (
        <BoardImageNative
          {...board}
          boardWidth={renderData.boardWidth}
          boardHeight={renderData.boardHeight}
          frames={climb.frames}
          mirrored={mirrored}
          style={{ width, height }}
          renderStyleOverride={renderStyle}
          onArtReadinessChange={onArtReadinessChange}
          showGridLabels
          overlayTestID="story-board-overlay"
        />
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({ root: { flex: 1, alignItems: 'center', justifyContent: 'center' } });
