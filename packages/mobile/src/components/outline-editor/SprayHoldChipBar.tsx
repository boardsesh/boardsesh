import React from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import type { SprayHoldRole } from './spray-hold-editor-reducer';
import type { RefineBrushSize } from './spray-refine';

type SprayHoldChipBarProps = {
  /** How the selected hold reads on the wall. Picks the chip set. */
  role: SprayHoldRole;
  canShrink: boolean;
  canGrow: boolean;
  onShrink: () => void;
  onGrow: () => void;
  onTrace: () => void;
  /** Touch up the outline with an add / erase brush (`'refine'` tool). */
  onRefine: () => void;
  onJoin: () => void;
  /** An ON ring or a maybe goes OFF, as a ghost. */
  onSwitchOff: () => void;
  /** A ghost goes back ON ("Switch on"), or a maybe is kept ("Keep"). */
  onSwitchOn: () => void;
  /** A ghost comes off the photo for good. The one hard removal. */
  onDelete: () => void;
};

/** Dimmed opacity for a chip that cannot act right now (smallest / biggest size reached). */
const DISABLED_OPACITY = 0.4;
/** The − and + glyphs, sized to read as the same weight as a chip's label. */
const STEP_ICON_SIZE = 18;

/**
 * What a picked hold can have done to it, one chip set per role:
 *
 * - ON: `[−] [+] Trace Refine Join Switch off`
 * - OFF ghost: `Switch on  Delete`
 * - maybe: `Keep  Switch off`
 *
 * Only on screen while a hold is selected, so the resting editor shows the wall
 * and three controls, and the fixing tools appear exactly when there is a hold
 * to fix. Delete only ever appears for a ghost, so taking a hold off the photo
 * is always two deliberate steps — switch it off, then delete it — and the
 * second one raises an undo toast.
 *
 * Every chip is the same glass capsule as the bottom bar's count, at the 44pt
 * touch floor, so the row reads as buttons over a bright photo, a dark one or
 * the black letterbox under a landscape wall alike. − and + are 44pt icon
 * chips. Delete is the same weight as its neighbours with a red label: it is
 * one tap away from an undo, not an alarm.
 *
 * Laid out in the flow of the screen's bottom dock (above the bottom bar,
 * under the undo toast), not positioned by itself.
 */
export const SprayHoldChipBar = React.memo(function SprayHoldChipBar({
  role,
  canShrink,
  canGrow,
  onShrink,
  onGrow,
  onTrace,
  onRefine,
  onJoin,
  onSwitchOff,
  onSwitchOn,
  onDelete,
}: SprayHoldChipBarProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  return (
    <View pointerEvents="box-none" style={styles.row}>
      {role === 'on' ? (
        <>
          <SprayHoldChip
            label={t('sprayEditor.a11y.actions.smaller')}
            iconName="minus"
            color={systemColors.label}
            disabled={!canShrink}
            onPress={onShrink}
          />
          <SprayHoldChip
            label={t('sprayEditor.a11y.actions.bigger')}
            iconName="plus"
            color={systemColors.label}
            disabled={!canGrow}
            onPress={onGrow}
          />
          <SprayHoldChip label={t('sprayEditor.chips.trace')} color={systemColors.label} onPress={onTrace} />
          <SprayHoldChip label={t('sprayEditor.chips.refine')} color={systemColors.label} onPress={onRefine} />
          <SprayHoldChip label={t('sprayEditor.chips.join')} color={systemColors.label} onPress={onJoin} />
          <SprayHoldChip label={t('sprayEditor.chips.switchOff')} color={systemColors.label} onPress={onSwitchOff} />
        </>
      ) : role === 'off' ? (
        <>
          <SprayHoldChip label={t('sprayEditor.chips.switchOn')} color={systemColors.label} onPress={onSwitchOn} />
          <SprayHoldChip label={t('sprayEditor.chips.delete')} color={brandColors.error} onPress={onDelete} />
        </>
      ) : (
        <>
          <SprayHoldChip label={t('sprayEditor.chips.keep')} color={systemColors.label} onPress={onSwitchOn} />
          <SprayHoldChip label={t('sprayEditor.chips.switchOff')} color={systemColors.label} onPress={onSwitchOff} />
        </>
      )}
    </View>
  );
});

type SprayCornersChipBarProps = {
  onFinish: () => void;
};

/**
 * Finish, docked where the hold chips sit, while a Corners outline has enough
 * corners to close. Tapping the first corner closes it too; this is the way to
 * close it when the first corner is off screen at 8×.
 */
export const SprayCornersChipBar = React.memo(function SprayCornersChipBar({ onFinish }: SprayCornersChipBarProps) {
  const { t } = useTranslation('boards');
  const { brandColors } = useTheme();
  return (
    <View pointerEvents="box-none" style={styles.row}>
      <SprayHoldChip label={t('sprayEditor.chips.finish')} color={brandColors.primary} onPress={onFinish} />
    </View>
  );
});

type SprayRefineBarProps = {
  brushSize: RefineBrushSize;
  onBrushSize: (size: RefineBrushSize) => void;
  /** Keep the refined area: one edit, one undo step. */
  onDone: () => void;
};

/** The three brush sizes, smallest first, with the dot each chip draws (in points). */
const REFINE_SIZE_CHIPS: readonly { size: RefineBrushSize; dot: number }[] = [
  { size: 'small', dot: 6 },
  { size: 'medium', dot: 11 },
  { size: 'large', dot: 18 },
];

/**
 * Refine's controls, docked where the hold chips sit: the brush size as three
 * dot chips, and Done. Add / Erase lives on the banner, next to Cancel, like
 * add mode's Draw / Corners; Undo is the bar's (or the rail's) Undo, which takes
 * back one stroke at a time while Refine is open.
 */
export const SprayRefineBar = React.memo(function SprayRefineBar({
  brushSize,
  onBrushSize,
  onDone,
}: SprayRefineBarProps) {
  const { t } = useTranslation('boards');
  const { brandColors } = useTheme();
  return (
    <View pointerEvents="box-none" style={styles.row} accessibilityLabel={t('sprayEditor.refine.size')}>
      {REFINE_SIZE_CHIPS.map(({ size, dot }) => (
        <SprayBrushSizeChip
          key={size}
          size={size}
          dot={dot}
          label={brushSizeLabel(size, t)}
          selected={size === brushSize}
          onSelect={onBrushSize}
        />
      ))}
      <SprayHoldChip label={t('sprayEditor.banner.done')} color={brandColors.primary} onPress={onDone} />
    </View>
  );
});

function brushSizeLabel(size: RefineBrushSize, t: (key: string) => string): string {
  if (size === 'small') return t('sprayEditor.refine.sizeSmall');
  if (size === 'large') return t('sprayEditor.refine.sizeLarge');
  return t('sprayEditor.refine.sizeMedium');
}

type SprayBrushSizeChipProps = {
  size: RefineBrushSize;
  /** The dot's diameter, in points. */
  dot: number;
  label: string;
  selected: boolean;
  onSelect: (size: RefineBrushSize) => void;
};

/** A 44pt glass chip with a dot the size of its brush; the picked one is ringed in violet. */
const SprayBrushSizeChip = React.memo(function SprayBrushSizeChip({
  size,
  dot,
  label,
  selected,
  onSelect,
}: SprayBrushSizeChipProps) {
  const { systemColors, brandColors } = useTheme();
  return (
    <PressableSurface
      onPress={() => onSelect(size)}
      feedback="scale"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      style={[styles.chip, styles.iconChip, styles.sizeChip, selected ? { borderColor: brandColors.primary } : null]}
    >
      <GlassSurface
        glassEffectStyle="regular"
        fallbackColor={systemColors.fill}
        borderRadius={glassSize.capsule / 2}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View
        style={{
          width: dot,
          height: dot,
          borderRadius: dot / 2,
          backgroundColor: selected ? brandColors.primary : systemColors.label,
        }}
      />
    </PressableSurface>
  );
});

type SprayHoldChipProps = {
  /** The visible label, or with `iconName` the screen-reader label alone. */
  label: string;
  /** Draws this glyph instead of the label: a square 44pt icon chip. */
  iconName?: IconName;
  color: ColorValue;
  disabled?: boolean;
  onPress: () => void;
};

const SprayHoldChip = React.memo(function SprayHoldChip({
  label,
  iconName,
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
      style={[styles.chip, iconName ? styles.iconChip : null, disabled ? styles.chipDisabled : null]}
    >
      <GlassSurface
        glassEffectStyle="regular"
        fallbackColor={systemColors.fill}
        borderRadius={glassSize.capsule / 2}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {iconName ? (
        <Icon name={iconName} size={STEP_ICON_SIZE} color={color} />
      ) : (
        <Text
          variant="subheadline"
          color={color}
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={styles.chipLabel}
        >
          {label}
        </Text>
      )}
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
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
  iconChip: {
    width: glassSize.capsule,
    paddingHorizontal: 0,
  },
  chipDisabled: {
    opacity: DISABLED_OPACITY,
  },
  chipLabel: {
    fontWeight: '600',
  },
  // Always bordered, so picking a size never shifts the dot; only the colour changes.
  sizeChip: {
    borderWidth: 2,
    borderColor: 'transparent',
  },
});
