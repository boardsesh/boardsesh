import { memo, useCallback, useState } from 'react';
import { StyleSheet, View, type ColorValue, type StyleProp, type TextLayoutEvent, type ViewStyle } from 'react-native';
import { Text, type TextVariant } from '../Text';
import { LargeContentViewer } from '../LargeContentViewer';
import { useTheme } from '../../providers/theme-provider';
import { useCappedTextProps, type CappedTextProps } from '../../hooks/use-capped-text-props';
import { materialSurfaces } from '../../theme/colors';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { printedThen, spokenCaption, type TrackLabelParts, type TrackThenParts } from './track-label-text';

/**
 * The fewest characters of the list's name "then" keeps on the first line
 * ("then Projec…"). With less room than that, "then Projects" takes a line of
 * its own while the second line is free.
 */
export const MIN_THEN_NAME_CHARACTERS = 6;

/**
 * Whether the first line has room for "then", as measured in the frame the top
 * bar has now (beside ⌄, the rest timer and ⋯, at the climber's text size):
 * `withName` with {@link MIN_THEN_NAME_CHARACTERS} of the list's name, `bare`
 * with the name cut to "…". Null until measured.
 */
export type ThenRoom = { withName: boolean | null; bare: boolean | null };

const UNMEASURED: ThenRoom = { withName: null, bare: null };

/**
 * The first lines the room is measured with: every word that is never cut
 * ("Up next · 4 of 4 · then "), plus the list's name at its shortest.
 */
export function thenRoomLines(parts: TrackLabelParts, tail: TrackThenParts): { withName: string; bare: string } {
  const lead = parts.count ? `${parts.name} · ${parts.count} · ` : `${parts.name} · `;
  const characters = Array.from(tail.name);
  const shortName =
    characters.length <= MIN_THEN_NAME_CHARACTERS
      ? tail.name
      : `${characters.slice(0, MIN_THEN_NAME_CHARACTERS).join('')}\u2026`;
  return {
    withName: `${lead}${tail.before}${shortName}${tail.after}`,
    bare: `${lead}${tail.before}\u2026${tail.after}`,
  };
}

/**
 * Where the top bar prints "then Projects", from the room measured for it:
 *
 * - `inline`: after the count, with the list's name cut at its end.
 * - `ownLine`: a line of its own, when the name would keep fewer than
 *   {@link MIN_THEN_NAME_CHARACTERS} characters and no caption needs line 2.
 * - `spoken`: with line 2 taken and not even "then …" fitting, nowhere on
 *   screen. The line never runs under ⌄ or the timer; the top bar's label and
 *   the board's value still say "then Projects" to a screen reader.
 * - null: nothing to say.
 *
 * Unmeasured counts as room: the first layout measures it.
 */
export function resolveThenPlacement({
  hasThen,
  hasCaption,
  room,
}: {
  hasThen: boolean;
  hasCaption: boolean;
  room: ThenRoom;
}): 'inline' | 'ownLine' | 'spoken' | null {
  if (!hasThen) return null;
  if (room.withName !== false) return 'inline';
  if (!hasCaption) return 'ownLine';
  return room.bare === false ? 'spoken' : 'inline';
}

/** The first line as printed: "Up next · 2 of 4 · then Projects". */
export function printedTrackLine(parts: TrackLabelParts): string {
  const line = parts.count ? `${parts.name} · ${parts.count}` : parts.name;
  return parts.thenTail ? `${line} · ${printedThen(parts.thenTail)}` : line;
}

/** Whether a measuring text laid out in one line: its words fit the frame. */
function fitsOneLine(event: TextLayoutEvent): boolean {
  return event.nativeEvent.lines.length <= 1;
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
 * "then". Where the room it measures leaves the name fewer than six characters,
 * "then Projects" takes line 2 when it is free, and with line 2 taken and no
 * room for even "then …" it is only spoken (see `resolveThenPlacement`). One
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
  // Kept across climbs: the next Up next climb's words re-measure on layout,
  // and the line does not jump back and forth while they do.
  const [thenRoom, setThenRoom] = useState<ThenRoom>(UNMEASURED);
  const handleWithNameLayout = useCallback((event: TextLayoutEvent) => {
    const withName = fitsOneLine(event);
    setThenRoom((room) => (room.withName === withName ? room : { ...room, withName }));
  }, []);
  const handleBareLayout = useCallback((event: TextLayoutEvent) => {
    const bare = fitsOneLine(event);
    setThenRoom((room) => (room.bare === bare ? room : { ...room, bare }));
  }, []);
  if (!parts && !caption) return null;
  const thenTail = parts?.thenTail ?? null;
  const thenPlacement = resolveThenPlacement({ hasThen: thenTail !== null, hasCaption: !!caption, room: thenRoom });
  const roomLines = parts && thenTail ? thenRoomLines(parts, thenTail) : null;
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
              <ThenTexts
                tail={thenTail}
                lead=" · "
                variant="caption1"
                color={systemColors.secondaryLabel}
                textProps={lineText}
              />
            ) : null}
          </View>
        ) : null}
        {/* Line 2's size, so the pair is as tall as the list and a caption are. */}
        {thenTail && thenPlacement === 'ownLine' ? (
          <View style={[styles.row, styles.thenLine]}>
            <ThenTexts
              tail={thenTail}
              lead=""
              variant="caption2"
              color={systemColors.secondaryLabel}
              textProps={captionText}
            />
          </View>
        ) : null}
        {/* Never seen and never read: the first line's words laid out across
            the frame, so a wrap says "then" has no room there. */}
        {roomLines ? (
          <>
            <Text
              variant="caption1"
              {...lineText}
              style={[lineText.style, styles.roomProbe]}
              onTextLayout={handleWithNameLayout}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              testID="play-drawer-then-room-name"
            >
              {roomLines.withName}
            </Text>
            <Text
              variant="caption1"
              {...lineText}
              style={[lineText.style, styles.roomProbe]}
              onTextLayout={handleBareLayout}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              testID="play-drawer-then-room-bare"
            >
              {roomLines.bare}
            </Text>
          </>
        ) : null}
        {caption ? (
          <Text
            variant="caption2"
            // Velvet's opaque secondary label on both variants (B1): iOS's
            // translucent secondaryLabel measures 3.44:1 on a white sheet; this
            // opaque grey clears 4.5:1 on every Glass and Material ground.
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
  variant,
  color,
  textProps,
}: {
  tail: TrackThenParts;
  /** " · " after the count on the first line; nothing on a line of its own. */
  lead: string;
  variant: TextVariant;
  color: ColorValue;
  textProps: CappedTextProps;
}) {
  return (
    <>
      <Text variant={variant} color={color} numberOfLines={1} {...textProps} style={[textProps.style, styles.whole]}>
        {`${lead}${tail.before}`}
      </Text>
      <Text variant={variant} color={color} numberOfLines={1} {...textProps} style={[textProps.style, styles.thenName]}>
        {tail.name}
      </Text>
      {tail.after ? (
        <Text variant={variant} color={color} numberOfLines={1} {...textProps} style={[textProps.style, styles.whole]}>
          {tail.after}
        </Text>
      ) : null}
    </>
  );
}

/** Points held back from the measured frame (see `roomProbe`). */
const ROOM_PROBE_SLACK = 4;

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
  // "then Projects" on a line of its own sits where a caption would.
  thenLine: {
    marginTop: 1,
  },
  // Spans the frame, a little narrower so the measured line never claims the
  // last points the split texts' rounding needs. Invisible and untouchable.
  roomProbe: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: ROOM_PROBE_SLACK,
    opacity: 0,
  },
});
