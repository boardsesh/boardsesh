import { PressableSurface } from '../PressableSurface';
import { memo } from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';

const GLYPH_SIZE = 16;
// The glyph's laid-out box: the glyph plus the 2pt padding it always had. The
// label row around the toggle is sized by this.
const GLYPH_BOX = GLYPH_SIZE + 2 * 2;
const MIN_TOUCH_TARGET = 44;
// The 44pt target is centred on the glyph box, and a negative margin gives the
// extra back, so the row keeps its height and the glyph stays where it was. The
// target overflows the row instead, which the new architecture still
// hit-tests; a hitSlop past the parent's bounds would be dropped.
const TARGET_OVERHANG = (MIN_TOUCH_TARGET - GLYPH_BOX) / 2;

export type PinToggleProps = {
  /** Whether the control's chip is pinned to the top row right now. */
  pinned: boolean;
  /** Pins or unpins it. The caller owns the pin store. */
  onToggle: () => void;
  /** The control's name as the climber reads it, e.g. "Grade range". */
  label: string;
};

/**
 * A small pin button placed on a pinnable filter control in a filter sheet.
 * Tapping it pins/unpins that control's chip in the surface's top chip row
 * (see #3768). Filled pin glyph + brand tint when pinned; outline + muted when
 * not. Prop-driven, so each surface (climbs, Logbook) wires its own pin store.
 */
function PinToggleComponent({ pinned, onToggle, label }: PinToggleProps) {
  const { t } = useTranslation('climbs');
  const { systemColors, brandColors } = useTheme();

  return (
    <PressableSurface
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ selected: pinned }}
      accessibilityLabel={
        pinned ? t('mobile.filter.unpinChip', { name: label }) : t('mobile.filter.pinChip', { name: label })
      }
      style={styles.button}
    >
      <Icon
        name={pinned ? 'pin.fill' : 'pin'}
        size={GLYPH_SIZE}
        color={pinned ? brandColors.primary : systemColors.tertiaryLabel}
      />
    </PressableSurface>
  );
}

const styles = StyleSheet.create({
  button: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    margin: -TARGET_OVERHANG,
    // Round, so the Android ripple is a circle round the glyph rather than a
    // square over the label beside it.
    borderRadius: MIN_TOUCH_TARGET / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export const PinToggle = memo(PinToggleComponent);
