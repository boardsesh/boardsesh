import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useCappedTextProps } from '../../hooks/use-capped-text-props';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import type { TrackLabelParts } from './track-label-text';

type PlayListContextProps = {
  /** Where the player is: a list ("Projects · 4 of 23") or a workout stage ("4x4 · Rep 3 of 4 · Set 2 of 4"). */
  parts: TrackLabelParts | null;
  /**
   * A second, smaller line about the wall rather than the list, such as
   * "Preview, not lit" (#6745). Here and not at the front of the header's stats
   * line, where it pushed the sends and stars off the end.
   */
  caption?: string | null;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * The player's top bar context, under the grabber. The name and the count are
 * two texts on one row, so a long name is cut at its end and the count after it
 * always shows whole. One element for VoiceOver, with the whole name.
 */
export const PlayListContext = memo(function PlayListContext({
  parts,
  caption = null,
  style,
  testID,
}: PlayListContextProps) {
  const { systemColors } = useTheme();
  // Capped like the rest of the bar's chrome, line height included, so two
  // lines at the largest Android text still fit under the grabber.
  const lineText = useCappedTextProps('caption1', CHROME_LABEL_MAX_FONT_SCALE);
  const captionText = useCappedTextProps('caption2', CHROME_LABEL_MAX_FONT_SCALE);
  if (!parts && !caption) return null;
  // Two sentences: where the player is, then what the wall is doing.
  const accessibilityLabel = [parts?.accessibilityLabel, caption].filter(Boolean).join('. ');
  return (
    <View
      // Two lines start below the grabber; one sits on the buttons' centre line.
      style={[styles.column, parts && caption ? styles.twoLines : null, style]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      {parts ? (
        <View style={styles.row}>
          <Text
            variant="caption1"
            color={systemColors.secondaryLabel}
            numberOfLines={1}
            {...lineText}
            style={[lineText.style, styles.name]}
          >
            {parts.name}
          </Text>
          {parts.count ? (
            <Text
              variant="caption1"
              color={systemColors.secondaryLabel}
              numberOfLines={1}
              numeric
              {...lineText}
              style={[lineText.style, styles.count]}
            >
              {` · ${parts.count}`}
            </Text>
          ) : null}
        </View>
      ) : null}
      {caption ? (
        <Text
          variant="caption2"
          color={systemColors.secondaryLabel}
          numberOfLines={1}
          {...captionText}
          style={[captionText.style, styles.caption]}
        >
          {caption}
        </Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  column: {
    alignItems: 'stretch',
    minWidth: 0,
  },
  // The 5pt grabber ends 10pt down the 44pt row; the pair centres in what is
  // left below it.
  twoLines: {
    paddingTop: 10,
  },
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
  // Never shrinks for the name, but is cut itself if it alone is wider than the
  // room (a long round count beside the rest timer on a small phone).
  count: {
    flexShrink: 0,
    maxWidth: '100%',
  },
  caption: {
    marginTop: 1,
    textAlign: 'center',
  },
});
