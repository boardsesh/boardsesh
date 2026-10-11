import { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { CLIMB_ROW_PRESET_IDS, type ClimbRowPresetId } from '../../../lib/climb-row-display';
import { useTheme } from '../../../providers/theme-provider';
import { spacing, borderRadius } from '../../../theme/tokens';
import { Text } from '../../Text';
import { climbRowPresetLabel } from './climb-list-settings-model';

export const ClimbRowPresetChips = memo(function ClimbRowPresetChips({
  activePreset,
  hasLastCustom,
  onSelect,
}: {
  activePreset: ClimbRowPresetId | 'custom';
  hasLastCustom: boolean;
  onSelect: (preset: ClimbRowPresetId | 'custom') => void;
}) {
  const { t } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const presets: readonly (ClimbRowPresetId | 'custom')[] =
    activePreset === 'custom' || hasLastCustom ? [...CLIMB_ROW_PRESET_IDS, 'custom'] : CLIMB_ROW_PRESET_IDS;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t('mobile.settings.climbList.presetsLabel')}
        style={styles.group}
      >
        {presets.map((preset) => (
          <Pressable
            key={preset}
            accessibilityRole="radio"
            aria-checked={activePreset === preset}
            accessibilityState={{ checked: activePreset === preset, selected: activePreset === preset }}
            onPress={() => onSelect(preset)}
            style={[
              styles.chip,
              {
                backgroundColor: systemColors.tertiaryBackground,
                borderColor: activePreset === preset ? brandColors.primary : systemColors.separator,
              },
            ]}
          >
            <Text variant="subheadline" numberOfLines={1}>
              {climbRowPresetLabel(preset, t)}
            </Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
});
const styles = StyleSheet.create({
  chips: { paddingHorizontal: spacing[4], paddingVertical: spacing[2] },
  group: { flexDirection: 'row', gap: spacing[2] },
  chip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing[3],
    borderWidth: 2,
    borderRadius: borderRadius.full,
  },
});
