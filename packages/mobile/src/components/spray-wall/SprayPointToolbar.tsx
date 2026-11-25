import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { Text } from '../Text';
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
  const { systemColors, selection } = useTheme();
  const color = selection.text;
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
          backgroundColor: systemColors.secondaryGroupedBackground,
          borderWidth: 2,
          borderColor: selected ? selection.checkmark : 'transparent',
          overflow: 'hidden',
          opacity: disabled ? 0.45 : 1,
        },
      ]}
    >
      {selected ? (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: selection.fill }]} />
      ) : null}
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
  const { systemColors, selection, spacing } = useTheme();
  const actions = [
    { mode: 'add', label: t('sprayLedSetup.add'), icon: 'plus' },
    { mode: 'move', label: t('sprayLedSetup.movePoint'), icon: 'move' },
    { mode: 'remove', label: t('sprayLedSetup.remove'), icon: 'minus' },
  ] as const;
  return (
    <View style={[icons ? styles.rail : styles.row, { gap: spacing[2] }]}>
      {actions.map((action) => {
        const selected = mode === action.mode;
        const color = selection.text;
        return (
          <PressableSurface
            key={action.mode}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityState={{ selected }}
            onPress={() => onModeChange(selected ? null : action.mode)}
            style={[
              icons ? styles.icon : styles.label,
              // A solid ground under the wash, plus a 2pt accent ring, so the selected tool
              // reads on the wall photo as well as on the toolbar.
              {
                backgroundColor: systemColors.secondaryGroupedBackground,
                borderWidth: 2,
                borderColor: selected ? selection.checkmark : 'transparent',
                overflow: 'hidden',
              },
            ]}
          >
            {selected ? (
              <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: selection.fill }]} />
            ) : null}
            {icons ? (
              <Icon name={action.icon} size={20} color={color} />
            ) : (
              <Text
                variant="footnote"
                color={color}
                emphasized={selected}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.65}
              >
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
  rail: { alignItems: 'center' },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
});
