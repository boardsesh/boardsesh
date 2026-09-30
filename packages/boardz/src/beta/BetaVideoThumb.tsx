import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Defs, Line, Pattern, Rect } from 'react-native-svg';
import type { BetaLink } from '@boardsesh/shared-schema';
import { Icon } from '../ui/Icon';
import { Play } from '../ui/icons';
import { Text } from '../ui/Text';
import { BOARD_PANEL, useTheme } from '../ui/theme';
import { radius } from '../ui/tokens';

// The design's play puck: paper at 92%, ink glyph.
const PUCK = 'rgba(244, 243, 239, 0.92)';
const PUCK_GLYPH = '#151618';

type BetaVideoThumbProps = {
  video: BetaLink;
  width: number;
  onPress: () => void;
};

/** A 4:5 beta card: the video's frame (or a hatched panel), a play puck, and who filmed it. */
export function BetaVideoThumb({ video, width, onPress }: BetaVideoThumbProps) {
  const theme = useTheme();
  const [imageFailed, setImageFailed] = useState(false);
  const handle = video.foreign_username?.trim() || null;
  const meta = [handle ? `@${handle}` : 'Beta video', video.angle !== null ? `${video.angle}°` : null]
    .filter(Boolean)
    .join(' · ');
  const showImage = video.thumbnail !== null && !imageFailed;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={handle ? `Beta video by ${handle}` : 'Beta video'}
      accessibilityHint="Opens the video"
      onPress={onPress}
      style={({ pressed }) => [styles.card, { width, opacity: pressed ? 0.8 : 1 }]}
    >
      <View
        style={[
          styles.frame,
          { height: width * 1.25, backgroundColor: BOARD_PANEL.panel, borderColor: BOARD_PANEL.edge },
        ]}
      >
        {showImage ? (
          <Image
            source={{ uri: video.thumbnail ?? undefined }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            cachePolicy="memory-disk"
            recyclingKey={video.thumbnail}
            transition={150}
            onError={() => setImageFailed(true)}
          />
        ) : (
          <>
            <Svg style={StyleSheet.absoluteFill}>
              <Defs>
                <Pattern id="hatch" width={9} height={9} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <Line x1={0} y1={0} x2={0} y2={9} stroke="#FFFFFF" strokeOpacity={0.05} strokeWidth={1} />
                </Pattern>
              </Defs>
              <Rect width="100%" height="100%" fill="url(#hatch)" />
            </Svg>
            <Text variant="label" color={theme.boardLabel} style={styles.placeholderLabel}>
              Beta
            </Text>
          </>
        )}
        <View style={styles.puck}>
          <Icon icon={Play} size={16} color={PUCK_GLYPH} filled />
        </View>
      </View>
      <Text variant="mono" tone="tertiary" numberOfLines={1} style={styles.meta}>
        {meta}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { gap: 6 },
  frame: { borderRadius: radius.md, borderCurve: 'continuous', borderWidth: 1, overflow: 'hidden' },
  placeholderLabel: { position: 'absolute', left: 10, top: 10, fontSize: 9 },
  puck: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 40,
    height: 40,
    marginLeft: -20,
    marginTop: -20,
    borderRadius: 20,
    backgroundColor: PUCK,
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 2,
  },
  meta: { fontSize: 10, lineHeight: 13 },
});
