import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { Button } from '../Button';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { PressableSurface } from '../PressableSurface';
import { SprayLedToolIcon, type SprayLedToolIconName } from './SprayLedToolIcon';

export type SprayPointMode = 'add' | 'move' | 'remove';

export function SprayPhotoToolButton({
  icon,
  label,
  onPress,
  disabled = false,
  selected,
}: {
  icon: IconName | SprayLedToolIconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
}) {
  const { systemColors, brandColors } = useTheme();
  const color = selected ? brandColors.onPrimary : systemColors.label;
  return (
    <PressableSurface
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.icon,
        {
          backgroundColor: selected ? brandColors.primary : systemColors.secondaryGroupedBackground,
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      {icon === 'next-unmapped-hold' ||
      icon === 'next-free-led' ||
      icon === 'select-two-leds' ||
      icon === 'insert-skipped-leds' ? (
        <SprayLedToolIcon name={icon} color={color} />
      ) : (
        <Icon name={icon} size={20} color={color} />
      )}
    </PressableSurface>
  );
}

export function SprayUndoButton({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
  const { t } = useTranslation('boards');
  return <SprayPhotoToolButton icon="undo" label={t('sprayLedSetup.undo')} disabled={disabled} onPress={onPress} />;
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
  const { spacing } = useTheme();
  const actions = [
    { mode: 'add', label: t('sprayLedSetup.add'), icon: 'plus' },
    { mode: 'move', label: t('sprayLedSetup.movePoint'), icon: 'move' },
    { mode: 'remove', label: t('sprayLedSetup.remove'), icon: 'minus' },
  ] as const;
  return (
    <View style={[icons ? styles.rail : styles.row, { gap: spacing[2] }]}>
      {actions.map((action) => {
        const selected = mode === action.mode;
        const onPress = () => onModeChange(selected ? null : action.mode);
        return icons ? (
          <SprayPhotoToolButton
            key={action.mode}
            icon={action.icon}
            label={action.label}
            selected={selected}
            onPress={onPress}
          />
        ) : (
          <Button
            key={action.mode}
            title={action.label}
            variant={selected ? 'filled' : 'outlined'}
            size="small"
            minHeight={44}
            onPress={onPress}
          />
        );
      })}
      <SprayUndoButton onPress={onUndo} disabled={!canUndo} />
    </View>
  );
}

const styles = StyleSheet.create({
  icon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  rail: { alignItems: 'center' },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
});
