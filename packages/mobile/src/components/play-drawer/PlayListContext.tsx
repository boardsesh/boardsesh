import { memo } from 'react';
import { StyleSheet, View, useWindowDimensions, type ColorValue, type StyleProp, type ViewStyle } from 'react-native';
import { Text } from '../Text';
import { LargeContentViewer } from '../LargeContentViewer';
import { useTheme } from '../../providers/theme-provider';
import { useCappedTextProps, type CappedTextProps } from '../../hooks/use-capped-text-props';
import { materialSurfaces } from '../../theme/colors';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { printedThen, spokenCaption, type TrackLabelParts, type TrackThenParts } from './track-label-text';

/**
 * From this text size (Android's 200%, iOS's accessibility sizes) the line's
 * "then Projects" goes onto a line of its own rather than cutting the list's
 * name away: the bar's text is capped, but the room beside the timer is not.
 */
export const THEN_OWN_LINE_FONT_SCALE = 2;

/**
 * Where the top bar prints "then Projects": on the first line, after the
 * count; on a line of its own at the largest text sizes, while no caption
 * needs the second line; or nowhere, with nothing to say.
 */
export function resolveThenPlacement({
  hasThen,
  hasCaption,
  fontScale,
}: {
  hasThen: boolean;
  hasCaption: boolean;
  fontScale: number;
}): 'inline' | 'ownLine' | null {
  if (!hasThen) return null;
  return !hasCaption && fontScale >= THEN_OWN_LINE_FONT_SCALE ? 'ownLine' : 'inline';
}

/** The first line as printed: "Up next · 2 of 4 · then Projects". */
export function printedTrackLine(parts: TrackLabelParts): string {
  const line = parts.count ? `${parts.name} · ${parts.count}` : parts.name;
  return parts.thenTail ? `${line} · ${printedThen(parts.thenTail)}` : line;
}

type PlayListContextProps = {
  /** Where the player is: a list ("Projects · 4 of 23") or a workout stage ("4x4 · Rep 3 of 4 · Set 2 of 4"). */
  parts: TrackLabelParts | null;
  /**
   * A second, smaller line about the wall rather than the list, such as
   * "Preview · not on the wall" (#6745). Here and not at the front of the
   * header's stats line, where it pushed the sends and stars off the end.
   */
  caption?: string | null;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * The player's top bar context, under the grabber. The name and the count are
 * two texts on one row, so a long name is cut at its end and the count after it
 * always shows whole. On a climb Up next whose list carries on, "· then
 * Projects" follows the count: only that list's name is cut, never the count or
 * "then", and at the largest text sizes it takes a line of its own instead. One
 * element for VoiceOver, with the whole name, and never a live region: twenty
 * swipes through previews are not twenty announcements.
 *
 * Its text is capped like the rest of the chrome, so on iOS a long press at an
 * accessibility text size shows both lines in the Large Content Viewer.
 */
export const PlayListContext = memo(function PlayListContext({
  parts,
  caption = null,
  style,
  testID,
}: PlayListContextProps) {
  const { systemColors, colorScheme } = useTheme();
  // Capped like the rest of the bar's chrome, line height included, so two
  // lines at the largest Android text still fit under the grabber.
  const lineText = useCappedTextProps('caption1', CHROME_LABEL_MAX_FONT_SCALE);
  const captionText = useCappedTextProps('caption2', CHROME_LABEL_MAX_FONT_SCALE);
  const { fontScale } = useWindowDimensions();
  if (!parts && !caption) return null;
  const thenTail = parts?.thenTail ?? null;
  const thenPlacement = resolveThenPlacement({ hasThen: thenTail !== null, hasCaption: !!caption, fontScale });
  // Two sentences: where the player is, then what the wall is doing.
  const accessibilityLabel = [parts?.accessibilityLabel, caption ? spokenCaption(caption) : null]
    .filter(Boolean)
    .join('. ');
  // The words as printed, for the Large Content Viewer: one line of its own
  // label, so the two lines join as two sentences.
  const printedLine = parts ? printedTrackLine(parts) : null;
  const largeContentTitle = [printedLine, caption].filter(Boolean).join('. ');
  const twoLines = !!parts && (!!caption || thenPlacement === 'ownLine');
  return (
    <LargeContentViewer title={largeContentTitle} style={style}>
      <View
        // Two lines start below the grabber; one sits on the buttons' centre line.
        style={[styles.column, twoLines ? styles.twoLines : null]}
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
              // With "then" after it, the list's name is what gets cut: "Up next" stays whole.
              style={[lineText.style, styles.name, thenPlacement === 'inline' ? styles.whole : null]}
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
            {thenTail && thenPlacement === 'inline' ? (
              <ThenTexts tail={thenTail} lead=" · " color={systemColors.secondaryLabel} lineText={lineText} />
            ) : null}
          </View>
        ) : null}
        {thenTail && thenPlacement === 'ownLine' ? (
          <View style={styles.row}>
            <ThenTexts tail={thenTail} lead="" color={systemColors.secondaryLabel} lineText={lineText} />
          </View>
        ) : null}
        {caption ? (
          <Text
            variant="caption2"
            // Velvet's opaque secondary label on both variants (B1): iOS's
            // translucent secondaryLabel measures 3.44:1 on a white sheet, this
            // one at least 6.1:1 on every Glass and Material ground.
            color={materialSurfaces[colorScheme].secondaryLabel}
            numberOfLines={1}
            {...captionText}
            style={[captionText.style, styles.caption]}
          >
            {caption}
          </Text>
        ) : null}
      </View>
    </LargeContentViewer>
  );
});

/**
 * "then Projects" as three texts: the words around the list's name never
 * shrink, and the name is cut at its end when the line runs out of room.
 */
function ThenTexts({
  tail,
  lead,
  color,
  lineText,
}: {
  tail: TrackThenParts;
  /** " · " after the count on the first line; nothing on a line of its own. */
  lead: string;
  color: ColorValue;
  lineText: CappedTextProps;
}) {
  return (
    <>
      <Text variant="caption1" color={color} numberOfLines={1} {...lineText} style={[lineText.style, styles.whole]}>
        {`${lead}${tail.before}`}
      </Text>
      <Text variant="caption1" color={color} numberOfLines={1} {...lineText} style={[lineText.style, styles.thenName]}>
        {tail.name}
      </Text>
      {tail.after ? (
        <Text variant="caption1" color={color} numberOfLines={1} {...lineText} style={[lineText.style, styles.whole]}>
          {tail.after}
        </Text>
      ) : null}
    </>
  );
}

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
  // Never cut: "Up next" beside a "then", and the words around the list's name.
  whole: {
    flexShrink: 0,
  },
  // The list "then" names: the first thing cut when the line runs out of room.
  thenName: {
    flexShrink: 1,
    minWidth: 0,
  },
});
