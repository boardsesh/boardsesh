import { memo } from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';

/** Whose grade a number is. Mirrors `GradeTokenSource` in `@boardsesh/logbook`. */
export type GradeSource = 'personal' | 'crowd';

export type GradeValueVariant = 'row' | 'header' | 'ladder';

type GradeValueProps = {
  /** Already formatted for the climber's grade-format preference. */
  label: string;
  /**
   * Ramp colour of the number actually shown — never of the number it replaced.
   *
   * `ColorValue`, not `string`, because a caller with no ramp colour to give
   * (the grade ladder's inactive rungs) falls back to the THEMED grey, and on
   * iOS `systemColors.secondaryLabel` is a `PlatformColor` handle rather than a
   * hex string. Those handles are built once in the theme provider, so they are
   * as memo-stable as a string literal.
   */
  color: ColorValue;
  /** Whose number this is. */
  source: GradeSource;
  /** Whose number this surface is ABOUT. Catalog surfaces are the crowd's. */
  baseline?: GradeSource;
  variant?: GradeValueVariant;
  accessibilityLabel?: string;
};

/**
 * The one grade slot every surface uses.
 *
 * A glyph on the number means the number is not the one this screen is about:
 * `person` where the screen is a catalog of the board's climbs and this number
 * is yours, `people` where the screen is your own diary and this number is the
 * crowd's. The two can never co-occur, because there is only ever ONE number
 * here. Whatever the other number is goes on the surface's stats/meta line
 * instead (see `crowdLineToken` in `@boardsesh/logbook`) — which is what keeps
 * this slot one line tall in every state.
 *
 * `alignItems: 'stretch'` on the container plus `textAlign: 'right'` on the
 * number makes the flush right edge construction rather than coincidence: the
 * number occupies the full slot and cannot slide sideways when a glyph appears
 * or disappears beside it. The `minWidth` therefore lives on the CONTAINER and
 * never flips — a floor on the Text would have to be given up the moment a
 * glyph took some of the width.
 *
 * Renders in virtualized list rows, so it is memoized on primitive props and
 * `useTheme()` is its only hook: no logbook read, no translation, no dimensions
 * subscription. Callers pass `accessibilityLabel` (built with
 * `gradeTokenA11yLabel`) because the glyph is not spoken.
 *
 * Note on type tiers: on the Material scale `caption1` and `caption2` are
 * byte-identical (11pt / 16 line-height / weight 500), so hierarchy in this
 * area has to come from colour and weight, never from tiering those two. That
 * is one reason the crowd's number left this column instead of sitting under
 * the main one in a smaller size.
 */
export const GradeValue = memo(function GradeValue({
  label,
  color,
  source,
  baseline = 'crowd',
  variant = 'row',
  accessibilityLabel,
}: GradeValueProps) {
  const { systemColors } = useTheme();
  // Same rule as `GradeTokenModel.mark` in @boardsesh/logbook, restated over the
  // two props this component already needs — `source` picks the glyph and
  // `baseline` says what the surface is about, so there is nothing left to pass.
  // Change one and change the other.
  //
  // The grade ladder is the exception: its rung already states provenance in
  // words beside a 20pt glyph gutter, so a marker here would be the third time
  // one row says the same thing.
  const mark = variant !== 'ladder' && source !== baseline;

  return (
    <View style={[styles.container, variant === 'ladder' ? styles.containerLadder : null]}>
      <View style={styles.inner}>
        {mark ? (
          <Icon name={source === 'personal' ? 'person' : 'people'} size={12} color={systemColors.secondaryLabel} />
        ) : null}
        <Text
          variant={variant === 'header' ? 'headline' : 'title3'}
          numberOfLines={1}
          accessibilityLabel={accessibilityLabel}
          style={[styles.number, { color }]}
        >
          {label}
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    // Stretch, not flex-end: the inner row fills the slot so the number's own
    // right alignment — not the container's — pins the edge.
    alignItems: 'stretch',
    // Never given up. The glyph is drawn INSIDE this floor, so a marked and an
    // unmarked row share one right edge and one column width.
    minWidth: 44,
    flexShrink: 0,
  },
  containerLadder: {
    // Fits the widest label the 'both' format produces ("V5 / 6C").
    minWidth: 56,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 3,
  },
  number: {
    fontWeight: '700',
    // Digits stack down a column of rows rather than jittering on glyph width.
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
});
