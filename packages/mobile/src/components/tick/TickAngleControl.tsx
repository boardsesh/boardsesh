// The tick sheets' angle control: a 24pt wall glyph, the angle as a number, and
// the shared AngleSlider. Both sheets render it inside a TickFormRow, so it adds
// no horizontal padding of its own (the row owns the gutter).
//
// Two stops (a MoonBoard at 25° / 40°) get a SegmentedControl instead of the
// slider: a two-stop slider is a toggle drawn as a track, and on Android
// Material's `steps={0}` lets the thumb rest between the stops. The segments
// print their own angles, so the number is dropped there rather than shown
// twice. The glyph stays either way.
import React, { useCallback, useMemo } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { SegmentedControl } from '../SegmentedControl';
import { AngleSlider } from '../play-drawer/AngleSlider';
import { withCurrentAngle } from '../play-drawer/AngleSlider.logic';
import { useTheme } from '../../providers/theme-provider';
import { AngleGlyph } from './AngleGlyph';

/** Floor for the number's box at 1x text, wide enough for "-5°" and "70°" in
 *  tabular SF Pro 17 with Bold Text on. A floor rather than a measured width so
 *  the slider's leading edge holds still as the value steps; the text keeps its
 *  natural (start) alignment, so a narrower "0°" leaves its slack on the slider
 *  side. */
const NUMBER_MIN_WIDTH = 36;

/**
 * Whether a tick sheet should show the angle row at all. A spray wall's angle is
 * fixed by the wall, and a board with fewer than two angles has nothing to pick.
 * The parent decides, so a hidden row leaves no empty TickFormRow behind.
 */
export function shouldShowAngleRow(boardName: string | undefined, angles: number[]): boolean {
  return boardName !== 'spray' && angles.length >= 2;
}

type TickAngleControlProps = {
  /** The board's angle table, from `useBoardAngleOptions`. */
  angles: number[];
  /** The selected angle. May be off the table (an Aurora-synced 37°). */
  value: number;
  onChange: (angle: number) => void;
  /** Names the slider / segment group for screen readers ("Angle"). */
  accessibilityLabel: string;
  /**
   * The angle the sheet opened at. An off-table opening angle stays a stop for
   * as long as the sheet shows this tick, so the climber can step off 37° and
   * back onto it, and the stop count doesn't change under a thumb mid-drag.
   * Defaults to `value`.
   */
  openingValue?: number;
};

export const TickAngleControl = React.memo(function TickAngleControl({
  angles,
  value,
  onChange,
  accessibilityLabel,
  openingValue = value,
}: TickAngleControlProps) {
  const { t } = useTranslation('climbs');
  const { spacing } = useTheme();
  const { fontScale } = useWindowDimensions();

  // Count the stops AFTER the off-table angles go in: MoonBoard's [25, 40] with a
  // synced 30° is three stops, and three stops is a slider.
  const stops = useMemo(
    () => withCurrentAngle(withCurrentAngle(angles, openingValue), value),
    [angles, openingValue, value],
  );

  const segmentOptions = useMemo(
    () => stops.map((angle) => ({ key: String(angle), label: t('mobile.tick.angleMeta', { angle }) })),
    [stops, t],
  );
  const handleSegmentSelect = useCallback((key: string) => onChange(Number(key)), [onChange]);

  if (stops.length < 2) return null;
  const segmented = stops.length === 2;

  return (
    <View style={styles.container}>
      <AngleGlyph angle={value} />
      {segmented ? null : (
        // Hidden from screen readers on both platforms: the slider beside it
        // already speaks "Angle, 40°", and a second element reading "40°" would
        // be a stop with nothing to do. Both props are platform-only, so setting
        // both needs no Platform.OS branch.
        <Text
          variant="body"
          numeric
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ marginStart: spacing[2], minWidth: NUMBER_MIN_WIDTH * Math.max(1, fontScale) }}
        >
          {`${value}°`}
        </Text>
      )}
      <View style={[styles.control, { marginStart: spacing[3] }]}>
        {segmented ? (
          <SegmentedControl
            options={segmentOptions}
            selectedKey={String(value)}
            onSelect={handleSegmentSelect}
            accessibilityLabel={accessibilityLabel}
          />
        ) : (
          <AngleSlider
            angles={stops}
            value={value}
            onChange={onChange}
            accessibilityLabel={accessibilityLabel}
            showValue={false}
          />
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  control: {
    flex: 1,
    minWidth: 0,
  },
});
