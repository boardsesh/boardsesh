// Delete, in the container the iOS destructive-row idiom assumes.
//
// The edit sheet used to float a centred red link mid-content with nothing
// bounding it. Hairlines top and bottom make it a group; carrying the red on the
// GLYPH only — label stays `label` — ranks it below the violet Save without
// hiding it.
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { TICK_GUTTER } from './tick-sheet-metrics';

const DESTRUCTIVE_ROW_HEIGHT = 44;
const DELETE_ICON_SIZE = 18;

type TickDestructiveRowProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
};

export const TickDestructiveRow = React.memo(function TickDestructiveRow({
  label,
  onPress,
  disabled = false,
}: TickDestructiveRowProps) {
  const { systemColors, brandColors, spacing, opacity } = useTheme();

  return (
    <View style={[styles.group, { borderTopColor: systemColors.separator, borderBottomColor: systemColors.separator }]}>
      <PressableSurface
        onPress={onPress}
        disabled={disabled}
        feedback="opacity"
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        style={[styles.row, { gap: spacing[3] }, disabled ? { opacity: opacity.disabled } : null]}
      >
        <Icon name="delete" size={DELETE_ICON_SIZE} color={brandColors.error} />
        <Text variant="body" color={systemColors.label}>
          {label}
        </Text>
      </PressableSurface>
    </View>
  );
});

const styles = StyleSheet.create({
  group: {
    // Full-bleed hairlines: the group is what makes this read as a destructive
    // ROW rather than a link that happens to be red.
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    minHeight: DESTRUCTIVE_ROW_HEIGHT,
    paddingHorizontal: TICK_GUTTER,
    flexDirection: 'row',
    alignItems: 'center',
  },
});
