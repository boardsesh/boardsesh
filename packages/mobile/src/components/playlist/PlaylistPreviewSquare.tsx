import { useMemo } from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { iosSystemColors } from '../../theme/ios-colors';
import { borderRadius } from '../../theme/tokens';
import { PLAYLIST_COLORS, isValidHexColor } from './playlist-colors';
import { PlaylistBoardBackdrop } from './PlaylistBoardBackdrop';
import { resolvePlaylistEmojiIcon } from './playlist-icon';

export type PlaylistPreviewSquareProps = {
  /** Playlist colour (hex). Falls back to a cycling palette colour. */
  color?: string;
  /** Emoji rendered centered. Falls back to a generic tag glyph. */
  icon?: string;
  /** Index into the fallback palette (so a list of cards cycles colours). */
  index?: number;
  /** Square edge length in px. */
  size?: number;
  style?: StyleProp<ViewStyle>;
  /** Board for the optional frosted board backdrop (detail hero only). */
  boardType?: string;
  layoutId?: number | null;
  /** Opt in to the board-image backdrop. Off by default so dense card lists
   *  stay cheap; enable on the detail hero where it renders once. */
  showBoardBackdrop?: boolean;
};

/**
 * Square playlist thumbnail: a colour-tinted background with a centered emoji.
 * With `showBoardBackdrop`, a blurred board image renders behind a translucent
 * colour tint (mirroring web's frosted preview); the backdrop is opt-in so the
 * dense card lists keep the cheap colour-only tile they ship with.
 */
export function PlaylistPreviewSquare({
  color,
  icon,
  index = 0,
  size = 64,
  style,
  boardType,
  layoutId,
  showBoardBackdrop = false,
}: PlaylistPreviewSquareProps) {
  const backgroundColor = useMemo(() => {
    if (color && isValidHexColor(color)) return color;
    return PLAYLIST_COLORS[index % PLAYLIST_COLORS.length];
  }, [color, index]);

  // Scale the centred glyph with the tile so the 96px hero and the 64px card
  // both read well.
  const emojiSize = Math.round(size * 0.42);
  const iconSize = Math.round(size * 0.38);
  const emojiIcon = resolvePlaylistEmojiIcon(icon);

  const withBackdrop = showBoardBackdrop && !!boardType;

  return (
    <View
      style={[
        styles.container,
        { backgroundColor, width: size, height: size, borderRadius: size >= 80 ? borderRadius.xl : borderRadius.lg },
        style,
      ]}
    >
      {withBackdrop ? (
        <>
          {/* Blurred board image, then a translucent colour tint over it so the
              board shows through while the emoji stays legible. */}
          <PlaylistBoardBackdrop boardType={boardType} layoutId={layoutId} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor, opacity: 0.55 }]} pointerEvents="none" />
        </>
      ) : null}
      {/* Soft top-left highlight, mirroring web's diagonal white gradient. */}
      <View style={styles.highlight} pointerEvents="none" />
      {emojiIcon ? (
        <Text
          style={[styles.emoji, { fontSize: emojiSize, lineHeight: Math.round(emojiSize * 1.3) }]}
          allowFontScaling={false}
        >
          {emojiIcon}
        </Text>
      ) : (
        <Icon name="tag" size={iconSize} color={iosSystemColors.white} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  highlight: {
    // A faux diagonal highlight: a translucent layer anchored to the top-left
    // corner (web renders a 135deg white gradient; this approximates it).
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: '45%',
    right: '45%',
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
  },
  emoji: {
    textAlign: 'center',
  },
});
