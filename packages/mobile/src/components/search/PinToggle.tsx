import { memo, useCallback } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { usePinnedChips } from '../../lib/pinned-chips-store';
import type { PinnableChipKind } from '../../lib/pinnable-chips';

/**
 * A small pin button placed on a pinnable filter control in the sheet. Tapping it
 * pins/unpins that control's chip in the persistent chip row (see #3768). Filled
 * pin glyph + brand tint when pinned; outline + muted when not. State lives in
 * pinned-chips-store (device-global, persisted); the chip row reacts live.
 */
function PinToggleComponent({ kind }: { kind: PinnableChipKind }) {
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();
  const { isPinned, togglePin } = usePinnedChips();
  const pinned = isPinned(kind);

  const onPress = useCallback(() => togglePin(kind), [togglePin, kind]);

  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityState={{ selected: pinned }}
      accessibilityLabel={pinned ? t('mobile.filter.unpin') : t('mobile.filter.pin')}
      style={styles.button}
    >
      <Icon
        name={pinned ? 'pin.fill' : 'pin'}
        size={16}
        color={pinned ? brandColors.primary : systemColors.tertiaryLabel}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    padding: 2,
  },
});

export const PinToggle = memo(PinToggleComponent);
