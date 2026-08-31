import { StyleSheet, View } from 'react-native';
import { BoardImageNative } from '../BoardImageNative';
import { useTheme } from '../../providers/theme-provider';
import { BOARD_PREVIEW_RENDER_WIDTH, type BoardPreviewSource } from '../../hooks/use-board-preview-climb';
import { BOARD_LOOK_CARD_WIDTH } from './BoardLookPreviewCard';
import { borderRadius, spacing } from '../../theme/tokens';

/**
 * Half again the size of a preset card, which is the point: the rail's cards are
 * for choosing between looks at a glance, and this is for judging one you are
 * actually tuning.
 */
export const CUSTOM_LOOK_PREVIEW_SIZE = Math.round(BOARD_LOOK_CARD_WIDTH * 1.5);

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

  return (
    <View style={styles.container}>
      <View style={[styles.frame, { backgroundColor: systemColors.tertiaryBackground }]}>
        <BoardImageNative
          frames={preview.frames}
          boardName={preview.boardName}
          layoutId={preview.layoutId}
          sizeId={preview.sizeId}
          setIds={preview.setIds}
          boardWidth={preview.boardWidth}
          boardHeight={preview.boardHeight}
          renderWidth={BOARD_PREVIEW_RENDER_WIDTH}
          // Letterboxed like the cards: a board is taller than it is wide, and
          // filling a square would cut the top and bottom rows off.
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
    width: CUSTOM_LOOK_PREVIEW_SIZE,
    height: CUSTOM_LOOK_PREVIEW_SIZE,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  boardImage: {
    width: 'auto',
    height: '100%',
  },
});
