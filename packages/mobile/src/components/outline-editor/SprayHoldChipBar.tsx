import React from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';

type SprayHoldChipBarProps = {
  /** Distance from the screen's bottom edge — docked just above the bottom bar. */
  bottom: number;
  canShrink: boolean;
  canGrow: boolean;
  onShrink: () => void;
  onGrow: () => void;
  onTrace: () => void;
  onJoin: () => void;
  onRemove: () => void;
};

/** Dimmed opacity for a chip that cannot act right now (smallest / biggest size reached). */
const DISABLED_OPACITY = 0.4;

/**
 * What a long-pressed hold can have done to it: size, shape, join, remove.
 *
 * Only on screen while a hold is selected, so the resting editor shows the wall
 * and three controls, and the fixing tools appear exactly when there is a hold
 * to fix.
 *
 * Every chip is the same glass capsule as the bottom bar's count, at the 44pt
 * touch floor, so the row reads as five buttons over a bright photo, a dark one
 * or the black letterbox under a landscape wall alike. Remove is the same
 * weight as its neighbours with a red label: it is one tap away from an undo,
 * not an alarm.
 */
export const SprayHoldChipBar = React.memo(function SprayHoldChipBar({
  bottom,
  canShrink,
  canGrow,
  onShrink,
  onGrow,
  onTrace,
  onJoin,
  onRemove,
}: SprayHoldChipBarProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  return (
    <View pointerEvents="box-none" style={[styles.root, { bottom }]}>
      <View pointerEvents="box-none" style={styles.row}>
        <SprayHoldChip
          label={t('sprayEditor.chips.smaller')}
          color={systemColors.label}
          disabled={!canShrink}
          onPress={onShrink}
        />
        <SprayHoldChip
          label={t('sprayEditor.chips.bigger')}
          color={systemColors.label}
          disabled={!canGrow}
          onPress={onGrow}
        />
        <SprayHoldChip label={t('sprayEditor.chips.trace')} color={systemColors.label} onPress={onTrace} />
        <SprayHoldChip label={t('sprayEditor.chips.join')} color={systemColors.label} onPress={onJoin} />
        <SprayHoldChip label={t('sprayEditor.chips.remove')} color={brandColors.error} onPress={onRemove} />
      </View>
    </View>
  );
});

type SprayCornersChipBarProps = {
  bottom: number;
  onFinish: () => void;
};

/**
 * Finish, docked where the hold chips sit, while a Corners outline has enough
 * corners to close. Tapping the first corner closes it too; this is the way to
 * close it when the first corner is off screen at 8×.
 */
export const SprayCornersChipBar = React.memo(function SprayCornersChipBar({
  bottom,
  onFinish,
}: SprayCornersChipBarProps) {
  const { t } = useTranslation('boards');
  const { brandColors } = useTheme();
  return (
    <View pointerEvents="box-none" style={[styles.root, { bottom }]}>
      <SprayHoldChip label={t('sprayEditor.chips.finish')} color={brandColors.primary} onPress={onFinish} />
    </View>
  );
});

type SprayHoldChipProps = {
  label: string;
  color: ColorValue;
  disabled?: boolean;
  onPress: () => void;
};

const SprayHoldChip = React.memo(function SprayHoldChip({
  label,
  color,
  disabled = false,
  onPress,
}: SprayHoldChipProps) {
  const { systemColors } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      disabled={disabled}
      feedback="scale"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={[styles.chip, disabled ? styles.chipDisabled : null]}
    >
      <GlassSurface
        glassEffectStyle="regular"
        fallbackColor={systemColors.fill}
        borderRadius={glassSize.capsule / 2}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <Text
        variant="subheadline"
        color={color}
        numberOfLines={1}
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.chipLabel}
      >
        {label}
      </Text>
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    left: spacing[4],
    right: spacing[4],
    alignItems: 'center',
  },
  // Tight enough that the five English chips fit one row on a 375pt phone;
  // longer labels or bigger type wrap to a second row rather than truncate.
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing[1],
  },
  chip: {
    minHeight: glassSize.capsule,
    minWidth: glassSize.capsule,
    borderRadius: glassSize.capsule / 2,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[2],
  },
  chipDisabled: {
    opacity: DISABLED_OPACITY,
  },
  chipLabel: {
    fontWeight: '600',
  },
});
