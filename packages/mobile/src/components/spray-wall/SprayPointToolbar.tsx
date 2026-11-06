import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';

export type SprayPointMode = 'add' | 'move' | 'remove';

export function SprayUndoButton({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      accessibilityRole="button"
      accessibilityLabel={t('sprayLedSetup.undo')}
      disabled={disabled}
      onPress={onPress}
      style={[styles.icon, { backgroundColor: systemColors.secondaryGroupedBackground, opacity: disabled ? 0.45 : 1 }]}
    >
      <Icon name="undo" size={20} color={systemColors.label} />
    </PressableSurface>
  );
}

export function SprayPointToolbar({
  mode,
  onModeChange,
  onUndo,
  canUndo,
  icons = false,
}: {
  mode: SprayPointMode | null;
  onModeChange: (mode: SprayPointMode | null) => void;
  onUndo: () => void;
  canUndo: boolean;
  icons?: boolean;
}) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors, spacing } = useTheme();
  const actions = [
    { mode: 'add', label: t('sprayLedSetup.add'), icon: 'plus' },
    { mode: 'move', label: t('sprayLedSetup.movePoint'), icon: 'move' },
    { mode: 'remove', label: t('sprayLedSetup.remove'), icon: 'minus' },
  ] as const;
  return (
    <View style={{ flexDirection: icons ? 'column' : 'row', alignItems: 'center', gap: spacing[2] }}>
      {actions.map((action) => {
        const selected = mode === action.mode;
        const color = selected ? brandColors.onPrimary : systemColors.label;
        return (
          <PressableSurface
            key={action.mode}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityState={{ selected }}
            onPress={() => onModeChange(selected ? null : action.mode)}
            style={[
              icons ? styles.icon : styles.label,
              { backgroundColor: selected ? brandColors.primary : systemColors.secondaryGroupedBackground },
            ]}
          >
            {icons ? (
              <Icon name={action.icon} size={20} color={color} />
            ) : (
              <Text variant="footnote" color={color} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.65}>
                {action.label}
              </Text>
            )}
          </PressableSurface>
        );
      })}
      <SprayUndoButton onPress={onUndo} disabled={!canUndo} />
    </View>
  );
}

const styles = StyleSheet.create({
  icon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  label: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    paddingHorizontal: 5,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
