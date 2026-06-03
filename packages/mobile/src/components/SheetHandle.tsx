import { memo } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import { useTheme } from '../providers/theme-provider';
import { sheetStyles, spacing } from '../theme/tokens';

type SheetCloseButtonProps = {
  onClose: () => void;
  style?: StyleProp<ViewStyle>;
};

// Chevron close button pinned to the top-right corner of a sheet. Standalone so
// drawers with their own bespoke handle (e.g. PlayDrawer) can drop it in
// without adopting the whole SheetHandle.
export const SheetCloseButton = memo(function SheetCloseButton({ onClose, style }: SheetCloseButtonProps) {
  const { systemColors } = useTheme();
  const { t } = useTranslation('common');

  return (
    <Pressable
      onPress={onClose}
      accessibilityRole="button"
      accessibilityLabel={t('ariaLabels.close')}
      hitSlop={8}
      style={({ pressed }) => [
        styles.closeButton,
        { backgroundColor: systemColors.fill as string },
        style,
        pressed && styles.closeButtonPressed,
      ]}
    >
      <Icon name="chevron.down" size={18} color={systemColors.secondaryLabel} />
    </Pressable>
  );
});

type SheetHandleProps = {
  onClose: () => void;
};

// Shared bottom-sheet handle. Renders gorhom's grabber pill centered (the drag
// handle) plus a chevron close button pinned to the top-right corner, so every
// sheet exposes both affordances in the same spot. Pass it to a gorhom sheet
// via `handleComponent` — gorhom feeds animated props we don't need, so the
// wrapper ignores them.
export const SheetHandle = memo(function SheetHandle({ onClose }: SheetHandleProps) {
  return (
    <View style={styles.handle}>
      <View style={sheetStyles.indicator} />
      <SheetCloseButton onClose={onClose} />
    </View>
  );
});

const styles = StyleSheet.create({
  handle: {
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButton: {
    position: 'absolute',
    top: 3,
    right: spacing[4],
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeButtonPressed: {
    opacity: 0.7,
  },
});
