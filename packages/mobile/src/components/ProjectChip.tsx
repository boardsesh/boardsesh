import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from './Text';
import { climbChipStyles } from './DraftChip';
import { useTheme } from '../providers/theme-provider';

type ProjectChipProps = {
  /** Spacing from the neighbour it sits beside; the chip itself carries none. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * "Project" chip, in the grade's own slot, for a published climb nobody has
 * graded yet (#5971, `isProjectClimb`). On a spray wall that is every climb
 * until its first ascent, whose grade becomes the climb's.
 *
 * The same neutral chip as Draft and Hidden: the slot's colour normally carries
 * the grade, and there is no grade to colour yet.
 */
export const ProjectChip = React.memo(function ProjectChip({ style, testID = 'climb-project-chip' }: ProjectChipProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();

  return (
    <View
      style={[climbChipStyles.chip, { backgroundColor: systemColors.fill }, style]}
      accessibilityRole="text"
      accessibilityLabel={t('mobile.project.chip')}
      testID={testID}
    >
      <Text variant="caption2" numberOfLines={1} color={systemColors.secondaryLabel}>
        {t('mobile.project.chip')}
      </Text>
    </View>
  );
});
