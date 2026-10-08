// One titled header for both tick sheets.
//
// The leading 4x32 bar is where the grade ramp now lives: the climb's colour
// identity, recoloured live as the climber picks a grade, kept out of the form
// itself so the rows below only ever speak the sheet's three hues. Replaces the
// create sheet's empty band with an off-ladder 30pt chevron, and the edit
// sheet's bare title Text — which had no close affordance at all.
//
// The close is the shared xmark (ChromeIconButton): closing a tick sheet throws
// nothing away that the leave guard doesn't already ask about, so it reads as the
// iOS 26 sheet close. It sits trailing because the grade bar holds the leading edge.
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../Text';
import { ChromeIconButton } from '../ChromeIconButton';
import { useTheme } from '../../providers/theme-provider';
import { TICK_GUTTER, TICK_HEADER_HEIGHT } from './tick-sheet-metrics';

type TickSheetHeaderProps = {
  title: string;
  subtitle?: string;
  /** Resolved by the caller via getGradeColor(name). `null`/undefined falls back
   *  to the separator tone, so an ungraded climb gets a quiet rule, not a hole. */
  gradeColor?: string | null;
  onClose: () => void;
  closeAccessibilityLabel: string;
};

export const TickSheetHeader = React.memo(function TickSheetHeader({
  title,
  subtitle,
  gradeColor,
  onClose,
  closeAccessibilityLabel,
}: TickSheetHeaderProps) {
  const { systemColors, spacing, borderRadius } = useTheme();

  return (
    <View style={[styles.header, { gap: spacing[3], borderBottomColor: systemColors.separator }]}>
      <View
        style={[
          styles.gradeBar,
          { borderRadius: borderRadius.sm, backgroundColor: gradeColor ?? systemColors.separator },
        ]}
      />
      <View style={styles.titles}>
        <Text variant="headline" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <ChromeIconButton
        testID="tick-sheet-close"
        icon="close"
        onPress={onClose}
        accessibilityLabel={closeAccessibilityLabel}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: TICK_GUTTER,
    minHeight: TICK_HEADER_HEIGHT,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  gradeBar: {
    width: 4,
    height: 32,
  },
  titles: {
    flex: 1,
    minWidth: 0,
  },
});
