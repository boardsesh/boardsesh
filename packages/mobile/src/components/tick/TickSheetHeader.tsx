// One titled header for both tick sheets.
//
// The leading 4x32 bar is where the grade ramp now lives: the climb's colour
// identity, recoloured live as the climber picks a grade, kept out of the form
// itself so the rows below only ever speak the sheet's three hues. Replaces the
// create sheet's empty band with an off-ladder 30pt chevron, and the edit
// sheet's bare title Text — which had no close affordance at all.
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { TICK_GUTTER, TICK_HEADER_HEIGHT } from './tick-sheet-metrics';

const CLOSE_TARGET = 44;

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
      <PressableSurface
        onPress={onClose}
        feedback="opacity"
        accessibilityRole="button"
        accessibilityLabel={closeAccessibilityLabel}
        style={[styles.close, { backgroundColor: systemColors.fill }]}
      >
        <Icon name="chevron.down" size={18} color={systemColors.secondaryLabel} />
      </PressableSurface>
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
  close: {
    width: CLOSE_TARGET,
    height: CLOSE_TARGET,
    borderRadius: CLOSE_TARGET / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
