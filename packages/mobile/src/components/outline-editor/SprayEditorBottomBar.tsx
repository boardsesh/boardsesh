import React from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { SPRAY_BAR_GUTTER, SPRAY_BAR_HEIGHT } from './spray-photo-frame';
import { SprayModeSwitcher } from './SprayModeSwitcher';
import type { SprayEditorMode } from './spray-editor-mode';

/** The undo and redo glyphs, the size `GlassIconButton` draws its own. */
const HISTORY_ICON_SIZE = 22;
/** Dimmed opacity for Undo with nothing to undo, matching a disabled glass button. */
const DISABLED_OPACITY = 0.4;
/** The Redo half's arrival and departure. Layout animations skip under Reduce Motion by default. */
const REDO_ENTERING = FadeIn.duration(150);
const REDO_EXITING = FadeOut.duration(150);
const PILL_LAYOUT = LinearTransition.duration(150);

type SprayEditorBottomBarProps = {
  canUndo: boolean;
  /** Something was undone and nothing edited since: the pill grows a Redo half. */
  canRedo: boolean;
  /** The mode that is on, for the switcher. */
  mode: SprayEditorMode;
  onModeChange: (mode: SprayEditorMode) => void;
  /** Read-only, or a commit is in flight: every control is disabled. */
  locked: boolean;
  bottomInset: number;
  onUndo: () => void;
  onRedo: () => void;
};

/**
 * The phone editor's floating bottom bar, one row: the Undo | Redo pill at the
 * left and the mode switcher at the right.
 *
 * Undo and Redo share one split glass pill, and the Redo half only slides in
 * while there is something to redo, so the redo arrow appears exactly when it
 * means something.
 *
 * Everything else the bar used to carry has moved where it reads better: the
 * count capsule (and the wall-wide menu it opens) to the top-left of the
 * editor, Add into the switcher as a mode beside Trace, Refine and Join, and
 * the primary button into the header next to "?". One row keeps the photo's
 * reserve (`SPRAY_BAR_RESERVE`) to 64 pt, so a 1x wall is that much bigger.
 */
export const SprayEditorBottomBar = React.memo(function SprayEditorBottomBar({
  canUndo,
  canRedo,
  mode,
  onModeChange,
  locked,
  bottomInset,
  onUndo,
  onRedo,
}: SprayEditorBottomBarProps) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();

  return (
    <View pointerEvents="box-none" style={[styles.root, { bottom: bottomInset + SPRAY_BAR_GUTTER }]}>
      <Animated.View layout={PILL_LAYOUT} style={styles.historyPill}>
        <GlassSurface
          glassEffectStyle="regular"
          fallbackColor={systemColors.fill}
          borderRadius={SPRAY_BAR_HEIGHT / 2}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <HistoryButton
          iconName="undo"
          label={t('sprayEditor.bar.undo')}
          color={systemColors.label}
          disabled={!canUndo || locked}
          onPress={onUndo}
        />
        {canRedo ? (
          <Animated.View entering={REDO_ENTERING} exiting={REDO_EXITING} style={styles.redoHalf}>
            <View style={[styles.pillDivider, { backgroundColor: systemColors.separator }]} />
            <HistoryButton
              iconName="redo"
              label={t('sprayEditor.bar.redo')}
              color={systemColors.label}
              disabled={locked}
              onPress={onRedo}
            />
          </Animated.View>
        ) : null}
      </Animated.View>

      <SprayModeSwitcher mode={mode} onChange={onModeChange} disabled={locked} />
    </View>
  );
});

type HistoryButtonProps = {
  iconName: 'undo' | 'redo';
  label: string;
  color: ColorValue;
  disabled: boolean;
  onPress: () => void;
};

/** One half of the Undo | Redo pill: a 48pt square, so each half is a full touch target. */
const HistoryButton = React.memo(function HistoryButton({
  iconName,
  label,
  color,
  disabled,
  onPress,
}: HistoryButtonProps) {
  return (
    <PressableSurface
      onPress={onPress}
      disabled={disabled}
      feedback="scale"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={[styles.historyButton, disabled ? styles.disabled : null]}
    >
      <Icon name={iconName} size={HISTORY_ICON_SIZE} color={color} />
    </PressableSurface>
  );
});

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    left: spacing[4],
    right: spacing[4],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[2],
  },
  historyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    height: SPRAY_BAR_HEIGHT,
    borderRadius: SPRAY_BAR_HEIGHT / 2,
    overflow: 'hidden',
  },
  historyButton: {
    width: SPRAY_BAR_HEIGHT,
    height: SPRAY_BAR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  redoHalf: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  pillDivider: {
    width: StyleSheet.hairlineWidth,
    height: SPRAY_BAR_HEIGHT / 2,
  },
  disabled: {
    opacity: DISABLED_OPACITY,
  },
});
