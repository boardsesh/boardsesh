import { StyleSheet, View } from 'react-native';
import { BoardImageNative } from '../BoardImageNative';
import { useTheme } from '../../providers/theme-provider';
import type { BoardPreviewSource } from '../../hooks/use-board-preview-climb';
import { RAIL_RENDER_WIDTH, RAIL_THUMB_HEIGHT, railThumbWidth } from './board-look-card-metrics';
import { borderRadius, spacing } from '../../theme/tokens';

/**
 * Half again the height of a preset card, which is the point: the rail's cards
 * are for choosing between looks at a glance, and this is for judging one you are
 * actually tuning.
 */
export const CUSTOM_LOOK_PREVIEW_SIZE = Math.round(RAIL_THUMB_HEIGHT * 1.5);

/** The preview plus the padding around it — a fixed-height host row needs this. */
export const CUSTOM_LOOK_PREVIEW_HEIGHT = CUSTOM_LOOK_PREVIEW_SIZE + spacing[4];

/**
 * The board you are tuning, at the top of the Custom look screen.
 *
 * Draws the climber's OWN stored settings — no override — so it always shows
 * exactly what the knobs below have produced. It follows the settings store, so
 * it redraws when a slider COMMITS on release rather than on every drag frame:
 * a board re-render per frame would be far worse than a redraw a moment later,
 * and the drag already moves the thumb and its value label live.
 */
export function CustomLookPreview({ preview }: { preview: BoardPreviewSource }) {
  const { systemColors } = useTheme();
  // Same rule as the rail cards, scaled up: the frame is the shape of the board,
  // so none of the wall is traded for letterbox bars.
  const width = Math.round(railThumbWidth(preview.boardWidth / preview.boardHeight) * 1.5);

  return (
    <View style={styles.container}>
      <View style={[styles.frame, { width, backgroundColor: systemColors.tertiaryBackground }]}>
        <BoardImageNative
          frames={preview.frames}
          boardName={preview.boardName}
          layoutId={preview.layoutId}
          sizeId={preview.sizeId}
          setIds={preview.setIds}
          boardWidth={preview.boardWidth}
          boardHeight={preview.boardHeight}
          renderWidth={RAIL_RENDER_WIDTH}
          // The frame IS the board's aspect, so the image fills it and nothing is
          // cropped or letterboxed.
          style={styles.boardImage}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: spacing[2],
  },
  frame: {
    height: CUSTOM_LOOK_PREVIEW_SIZE,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  boardImage: {
    width: '100%',
    height: '100%',
  },
});
