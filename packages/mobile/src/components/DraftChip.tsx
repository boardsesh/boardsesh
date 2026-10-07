import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from './Text';
import { useTheme } from '../providers/theme-provider';

/**
 * The one small status chip a climb can carry beside its name: Draft here, and
 * the Hidden and "N holds gone" chips in the climb row, which share this shape.
 *
 * Neutral `fill` / `secondaryLabel` on purpose. Wherever a climb is shown, the
 * one colour signal is its grade, and a tinted chip beside it would compete.
 */
export const climbChipStyles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    // Never absorbs the row's truncation — the climb name does.
    flexShrink: 0,
  },
});

type DraftChipProps = {
  /** Spacing from the neighbour it sits beside; the chip itself carries none. */
  style?: StyleProp<ViewStyle>;
  /** Caps Dynamic Type in fixed-height chrome (the bottom bar). */
  maxFontSizeMultiplier?: number;
  testID?: string;
};

/**
 * "Draft" chip for a climb only its setter can see (#5954).
 *
 * A draft is left out of the Climbs list, so the places that DO show one — your
 * own queue, the play drawer, the bottom bar, Open drafts — have to say why it
 * is not in that list. Before this the only marker was a word in the list row's
 * subtitle, and the drawer and the bar said nothing.
 *
 * Callers render it only when `climb.is_draft === true`. Memoized, and every
 * prop is a primitive or a static style, so a row that is a draft renders the
 * chip once per mount and a row that is not pays nothing.
 */
export const DraftChip = React.memo(function DraftChip({
  style,
  maxFontSizeMultiplier,
  testID = 'climb-draft-chip',
}: DraftChipProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();

  return (
    <View
      style={[climbChipStyles.chip, { backgroundColor: systemColors.fill }, style]}
      accessibilityRole="text"
      accessibilityLabel={t('createClimbForm.draftBadge')}
      testID={testID}
    >
      <Text
        variant="caption2"
        numberOfLines={1}
        color={systemColors.secondaryLabel}
        maxFontSizeMultiplier={maxFontSizeMultiplier}
      >
        {t('createClimbForm.draftBadge')}
      </Text>
    </View>
  );
});
