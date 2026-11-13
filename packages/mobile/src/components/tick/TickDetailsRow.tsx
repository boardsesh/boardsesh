// The Android create sheet's fold (#7343): one quiet row that holds Angle and
// Date until the climber wants them. It opens one way, so nothing can be changed
// and then hidden again in the same sitting; the host swaps it for the real rows.
//
// The date part reads "Now" until the climber edits it, because an untouched tick
// saves at save time. `climbedAt` would be a guess at that moment.
//
// A changed value gets the label colour and a medium weight rather than an
// accent: the sheet's violet is for what the climber is about to do, and this
// only has to say "not the default".
import React from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { formatTimeForDisplay } from '../logbook/climbed-at';
import { getCachedDateTimeFormat } from '../../lib/intl-formatter-cache';
import { useTheme } from '../../providers/theme-provider';
import { TickFormRow } from './TickFormRow';
import { TICK_DETAILS_ROW_HEIGHT, TICK_STACK_FONT_SCALE } from './tick-sheet-metrics';

/** Punctuation between the two values, the same glyph in every locale. */
const SUMMARY_SEPARATOR = ' · ';
const CHEVRON_SIZE = 16;

// `Intl`, not `formatDateForDisplay`: that one is ISO, and this reads as a sentence.
// The time still comes from `formatTimeForDisplay`, so it matches the row it folds.
const DATE_FORMAT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
const DATE_WITH_YEAR_FORMAT: Intl.DateTimeFormatOptions = { ...DATE_FORMAT, year: 'numeric' };

function isSameLocalDay(first: Date, second: Date): boolean {
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

type TickDetailsRowProps = {
  /** The angle the tick will save at. `null` on boards with no angle row (spray
   *  walls, fewer than two angles), which then summarise the date alone. */
  angle: number | null;
  openingAngle: number;
  climbedAt: Date;
  /** "Now" for the "Today" comparison. Passed in so render stays pure: the form
   *  already re-samples it once a minute. */
  now: Date;
  dateEdited: boolean;
  onPress: () => void;
};

export const TickDetailsRow = React.memo(function TickDetailsRow({
  angle,
  openingAngle,
  climbedAt,
  now,
  dateEdited,
  onPress,
}: TickDetailsRowProps) {
  const { t, i18n } = useTranslation('climbs');
  const { systemColors, spacing } = useTheme();
  const { fontScale } = useWindowDimensions();
  const locale = i18n.resolvedLanguage ?? i18n.language;

  const angleChanged = angle != null && angle !== openingAngle;
  const angleText = angle == null ? null : t('mobile.tick.angleMeta', { angle });

  let whenText = t('mobile.tick.detailsNow');
  if (dateEdited) {
    const timeText = formatTimeForDisplay(climbedAt);
    if (isSameLocalDay(climbedAt, now)) {
      whenText = t('mobile.tick.detailsToday', { time: timeText });
    } else {
      const format = climbedAt.getFullYear() === now.getFullYear() ? DATE_FORMAT : DATE_WITH_YEAR_FORMAT;
      whenText = `${getCachedDateTimeFormat(locale, format).format(climbedAt)} ${timeText}`;
    }
  }

  const whenAria = dateEdited ? t('mobile.tick.detailsDateChangedAria', { when: whenText }) : whenText;
  let accessibilityLabel = t('mobile.tick.detailsAriaNoAngle', { when: whenAria });
  if (angle != null) {
    const angleAria = angleChanged
      ? t('mobile.tick.detailsAngleChangedAria', { angle })
      : t('mobile.tick.detailsAngleAria', { angle });
    accessibilityLabel = t('mobile.tick.detailsAria', { angle: angleAria, when: whenAria });
  }

  const valueColor = (changed: boolean) => (changed ? systemColors.label : systemColors.secondaryLabel);

  return (
    <PressableSurface
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID="tick-details-row"
      // The row is a minHeight, so large text grows it rather than clipping.
      // Stacked (label over value) the two lines would otherwise touch the
      // pressable's edges.
      style={fontScale > TICK_STACK_FONT_SCALE ? { paddingVertical: spacing[2] } : undefined}
    >
      <TickFormRow label={t('mobile.tick.detailsLabel')} height={TICK_DETAILS_ROW_HEIGHT} showSeparator={false}>
        <Text variant="subheadline" color={systemColors.secondaryLabel} numberOfLines={2} style={styles.summary}>
          {angleText == null ? null : (
            <>
              <Text
                variant="subheadline"
                color={valueColor(angleChanged)}
                style={angleChanged ? styles.changedValue : undefined}
              >
                {angleText}
              </Text>
              {SUMMARY_SEPARATOR}
            </>
          )}
          <Text
            variant="subheadline"
            color={valueColor(dateEdited)}
            style={dateEdited ? styles.changedValue : undefined}
          >
            {whenText}
          </Text>
        </Text>
        <Icon name="chevron.down" size={CHEVRON_SIZE} color={systemColors.secondaryLabel} />
      </TickFormRow>
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  summary: {
    flex: 1,
    minWidth: 0,
  },
  changedValue: {
    fontWeight: '500',
  },
});
