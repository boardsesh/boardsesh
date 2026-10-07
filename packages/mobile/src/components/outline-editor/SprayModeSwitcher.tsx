import React, { useCallback, useState } from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { Text } from '../Text';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { SPRAY_MODES, type SprayEditorMode } from './spray-editor-mode';
import { SPRAY_BAR_HEIGHT } from './spray-photo-frame';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** One segment: the 44 pt touch floor. */
export const SPRAY_MODE_SEGMENT_SIZE = glassSize.capsule;
/** The capsule's inset round its segments, so it is the bar's 48 pt tall. */
const CAPSULE_PADDING = (SPRAY_BAR_HEIGHT - SPRAY_MODE_SEGMENT_SIZE) / 2;
/** A segment's glyph, the size the bar's other glass buttons draw theirs. */
const MODE_ICON_SIZE = 22;
/** Dimmed opacity while the wall is locked, matching a disabled glass button. */
const DISABLED_OPACITY = 0.4;

/**
 * A mode's name and what it does, as the switcher, the iPad rail and a screen
 * reader say them. Literal keys, so the catalogue checks can see them.
 */
export function sprayModeCopy(mode: SprayEditorMode, t: Translate): { label: string; hint: string } {
  switch (mode) {
    case 'select':
      return { label: t('sprayEditor.modes.select'), hint: t('sprayEditor.modes.hints.select') };
    case 'add':
      return { label: t('sprayEditor.modes.add'), hint: t('sprayEditor.modes.hints.add') };
    case 'trace':
      return { label: t('sprayEditor.modes.trace'), hint: t('sprayEditor.modes.hints.trace') };
    case 'refine':
      return { label: t('sprayEditor.modes.refine'), hint: t('sprayEditor.modes.hints.refine') };
    case 'join':
      return { label: t('sprayEditor.modes.join'), hint: t('sprayEditor.modes.hints.join') };
  }
}

type SprayModeSwitcherProps = {
  /** The mode that is on. */
  mode: SprayEditorMode;
  /**
   * A segment was tapped. Tapping the mode that is on asks for Select, so a
   * mode is left the way it was entered. The screen decides whether the switch
   * happens (and buzzes for it), so the rail and the keys share its rule.
   */
  onChange: (mode: SprayEditorMode) => void;
  /** Read-only, a save in flight, or the reveal still running. */
  disabled: boolean;
};

/**
 * The phone editor's modes, always on screen at the right of the bottom bar: a
 * 48 pt glass capsule of five 44 pt icon segments — Select, Add, Trace, Refine,
 * Join. The mode that is on sits on a raised neutral pill, never brand colour,
 * so the wall's violet rings stay the only violet in view.
 *
 * Icons only, so the bar fits a 375 pt phone in every language beside the
 * Undo | Redo pill at its widest. A press and hold on a segment shows its name
 * above the capsule while the finger stays down; a screen reader hears the name
 * and what the mode does.
 */
export const SprayModeSwitcher = React.memo(function SprayModeSwitcher({
  mode,
  onChange,
  disabled,
}: SprayModeSwitcherProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  /** The segment being pressed and held, whose name shows above the capsule. */
  const [peekMode, setPeekMode] = useState<SprayEditorMode | null>(null);

  const handleSelect = useCallback(
    (target: SprayEditorMode) => {
      if (target === mode) {
        if (mode !== 'select') onChange('select');
        return;
      }
      onChange(target);
    },
    [mode, onChange],
  );
  const handlePeekEnd = useCallback(() => setPeekMode(null), []);

  const peekLabel = peekMode && !disabled ? sprayModeCopy(peekMode, t).label : null;

  return (
    <View style={styles.wrapper} pointerEvents="box-none">
      {peekLabel ? (
        <View pointerEvents="none" style={styles.peekTrack}>
          <View style={styles.peekBubble}>
            <GlassSurface
              glassEffectStyle="regular"
              fallbackColor={systemColors.fill}
              borderRadius={glassSize.mini / 2}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <Text
              variant="footnote"
              color={systemColors.label}
              numberOfLines={1}
              maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
              style={styles.peekLabel}
            >
              {peekLabel}
            </Text>
          </View>
        </View>
      ) : null}
      <View
        testID="spray-mode-switcher"
        accessibilityRole="toolbar"
        accessibilityLabel={t('sprayEditor.modes.label')}
        style={[styles.capsule, disabled ? styles.disabled : null]}
      >
        <GlassSurface
          glassEffectStyle="regular"
          fallbackColor={systemColors.fill}
          borderRadius={SPRAY_BAR_HEIGHT / 2}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {SPRAY_MODES.map((spec) => {
          const copy = sprayModeCopy(spec.mode, t);
          const selected = spec.mode === mode;
          return (
            <ModeSegment
              key={spec.mode}
              mode={spec.mode}
              iconName={spec.iconName}
              label={copy.label}
              hint={copy.hint}
              selected={selected}
              disabled={disabled}
              color={selected ? systemColors.label : systemColors.secondaryLabel}
              pillColor={systemColors.elevatedSurface}
              onSelect={handleSelect}
              onPeek={setPeekMode}
              onPeekEnd={handlePeekEnd}
            />
          );
        })}
      </View>
    </View>
  );
});

type ModeSegmentProps = {
  mode: SprayEditorMode;
  iconName: IconName;
  label: string;
  hint: string;
  selected: boolean;
  disabled: boolean;
  color: ColorValue;
  pillColor: ColorValue;
  onSelect: (mode: SprayEditorMode) => void;
  onPeek: (mode: SprayEditorMode) => void;
  onPeekEnd: () => void;
};

/** One 44 pt square in the capsule. */
const ModeSegment = React.memo(function ModeSegment({
  mode,
  iconName,
  label,
  hint,
  selected,
  disabled,
  color,
  pillColor,
  onSelect,
  onPeek,
  onPeekEnd,
}: ModeSegmentProps) {
  const handlePress = useCallback(() => onSelect(mode), [onSelect, mode]);
  const handleLongPress = useCallback(() => onPeek(mode), [onPeek, mode]);
  return (
    <PressableSurface
      testID={`spray-mode-${mode}`}
      onPress={handlePress}
      onLongPress={handleLongPress}
      onPressOut={onPeekEnd}
      disabled={disabled}
      feedback="scale"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ selected, disabled }}
      style={[styles.segment, selected ? { backgroundColor: pillColor } : null]}
    >
      <Icon name={iconName} size={MODE_ICON_SIZE} color={color} />
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    height: SPRAY_BAR_HEIGHT,
    padding: CAPSULE_PADDING,
    borderRadius: SPRAY_BAR_HEIGHT / 2,
  },
  segment: {
    width: SPRAY_MODE_SEGMENT_SIZE,
    height: SPRAY_MODE_SEGMENT_SIZE,
    borderRadius: SPRAY_MODE_SEGMENT_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: DISABLED_OPACITY,
  },
  // Centred over the whole capsule rather than the held segment, so a long
  // German name over the last segment never runs off the screen's edge.
  peekTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: SPRAY_BAR_HEIGHT + spacing[1],
    alignItems: 'center',
  },
  peekBubble: {
    height: glassSize.mini,
    borderRadius: glassSize.mini / 2,
    overflow: 'hidden',
    justifyContent: 'center',
    paddingHorizontal: spacing[3],
  },
  peekLabel: {
    fontWeight: '600',
  },
});
