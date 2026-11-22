import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { cardCorners, spacing } from '../../theme/tokens';
import { ActivityIndicator } from '../ActivityIndicator';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';

type CreateAddHoldsRowProps = {
  onPress: () => void;
  disabled?: boolean;
  opening?: boolean;
  failed?: boolean;
};

/** A wall-editing detour, presented separately from the climb's paint tools. */
export const CreateAddHoldsRow = memo(function CreateAddHoldsRow({
  onPress,
  disabled = false,
  opening = false,
  failed = false,
}: CreateAddHoldsRowProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, surfaces } = useTheme();
  const unavailable = disabled || opening;
  const title = opening ? t('mobile.create.holds.opening') : t('mobile.create.holds.add');
  return (
    <View style={styles.container}>
      <PressableSurface
        onPress={onPress}
        disabled={unavailable}
        feedback="opacity"
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityHint={t('mobile.create.holds.hint')}
        accessibilityState={{ disabled: unavailable, busy: opening }}
        style={[styles.row, { backgroundColor: surfaces.plain.tile, borderColor: systemColors.separator }]}
        testID="create-add-holds"
      >
        <View style={styles.icon} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {opening ? (
            <ActivityIndicator size="small" color={systemColors.accent} />
          ) : (
            <Icon name="add" size={24} color={systemColors.accent} maxFontSizeMultiplier={1} />
          )}
        </View>
        <View style={styles.text}>
          <Text variant="subheadline" emphasized>
            {title}
          </Text>
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('mobile.create.holds.hint')}
          </Text>
        </View>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Icon name="chevron.right" size={14} color={systemColors.secondaryLabel} maxFontSizeMultiplier={1} />
        </View>
      </PressableSurface>
      {failed ? (
        <Text variant="caption1" color={systemColors.error} accessibilityLiveRegion="polite">
          {t('mobile.create.holds.openFailed')}
        </Text>
      ) : null}
    </View>
  );
});
const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing[4], paddingVertical: spacing[2], gap: spacing[2] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    padding: spacing[3],
    minHeight: spacing[12],
    borderWidth: StyleSheet.hairlineWidth,
    ...cardCorners,
  },
  icon: { width: spacing[6], alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  text: { flex: 1, minWidth: 0, gap: spacing[1] },
});
