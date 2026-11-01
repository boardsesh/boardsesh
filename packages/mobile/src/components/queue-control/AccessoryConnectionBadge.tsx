import { StyleSheet, View } from 'react-native';
import { Icon } from '../Icon';
import { CornerStatusDisc } from '../board-presence/CornerStatusDisc';
import type { BoardConnectionBadgeVisual } from './board-control-indicator-state';

// The Dynamic Island's glyph size on a disc about half the 32pt platter artwork.
const BADGE_DISC_SIZE = 14;
const BADGE_GLYPH_SIZE = 9;

/**
 * The board-connection mark on the accessory platter's climb thumbnail (see
 * `getBoardConnectionBadgeVisual`). It stays mounted at one size and only its
 * glyph and opacity change: UIKit snapshots the platter as it moves between the
 * open and collapsed placements, and a mark that mounted and unmounted there is
 * how doubled, offset glass content has shown up before. Decorative; the row
 * speaks the state through its accessibility value.
 */
export function AccessoryConnectionBadge({ visual }: { visual: BoardConnectionBadgeVisual | null }) {
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, visual === null ? styles.hidden : null]}
      testID="accessory-connection-badge"
    >
      <CornerStatusDisc size={BADGE_DISC_SIZE}>
        {/* A placeholder glyph keeps the tree the same shape while the mark is hidden. */}
        <Icon
          maxFontSizeMultiplier={1}
          name={visual?.iconName ?? 'lightbulb.fill'}
          size={BADGE_GLYPH_SIZE}
          color={visual?.iconColor}
        />
      </CornerStatusDisc>
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { opacity: 0 },
});
