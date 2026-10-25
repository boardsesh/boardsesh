// "Last on the wall …" under the climb while the #4979 hold keeps the board dark
// (docs/current-climb-outside-queue.md, section 6, decision 9). It sits with Put
// on the wall so a dark board right after connecting reads as "this climb has
// been here since Tuesday", not as a Bluetooth failure. It reads the same clock
// the hold does, so the line and the hold can't disagree.

import { memo } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { nowMs } from '../../lib/clock';
import { formatLastOnWall } from '../../lib/last-on-wall';
import { Text } from '../Text';

type LastOnWallNoteProps = {
  /** Epoch ms the held climb became the current climb. */
  lastOnWallAt: number;
};

function LastOnWallNoteImpl({ lastOnWallAt }: LastOnWallNoteProps) {
  const { t, i18n } = useTranslation('session');
  const { systemColors } = useTheme();
  const text = formatLastOnWall(lastOnWallAt, nowMs(), t, i18n.language);
  return (
    <Text
      testID="play-drawer-last-on-wall"
      variant="caption1"
      color={systemColors.secondaryLabel}
      numberOfLines={1}
      accessibilityRole="text"
      style={styles.note}
    >
      {text}
    </Text>
  );
}

export const LastOnWallNote = memo(LastOnWallNoteImpl);

const styles = StyleSheet.create({
  note: {
    textAlign: 'center',
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[1],
  },
});
