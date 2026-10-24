import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import type { TrackLabelParts } from './track-label-text';

type PlayListContextProps = {
  parts: TrackLabelParts;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * "Projects · 4 of 23": the list the player walks. Two texts on one row so a
 * long name is cut at its end and the count after it always shows whole.
 */
export const PlayListContext = memo(function PlayListContext({ parts, style, testID }: PlayListContextProps) {
  const { systemColors } = useTheme();
  return (
    <View
      style={[styles.row, style]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={parts.accessibilityLabel}
      testID={testID}
    >
      <Text
        variant="caption1"
        color={systemColors.secondaryLabel}
        numberOfLines={1}
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.name}
      >
        {parts.name}
      </Text>
      {parts.count ? (
        <Text
          variant="caption1"
          color={systemColors.secondaryLabel}
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          numeric
          style={styles.count}
        >
          {` · ${parts.count}`}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 0,
  },
  // Right-aligned so the space a cut name leaves after its "…" falls on its
  // outer edge, not between the name and the count.
  name: {
    flexShrink: 1,
    minWidth: 0,
    textAlign: 'right',
  },
  count: {
    flexShrink: 0,
  },
});
