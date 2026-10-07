import React from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { GlassIconButton } from '../GlassIconButton';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import type { SprayEditorCounts } from './spray-hold-editor-reducer';
import { SPRAY_BAR_GUTTER, SPRAY_BAR_HEIGHT } from './spray-photo-frame';
import { SprayCountCapsule, SprayEditorMenu } from './SprayCountCapsule';

// Re-exported so the editor imports the count line from where it always has.
export { sprayCountSummary } from './SprayCountCapsule';

/** The undo and redo glyphs, the size `GlassIconButton` draws its own. */
const HISTORY_ICON_SIZE = 22;
/** Dimmed opacity for Undo with nothing to undo, matching a disabled glass button. */
const DISABLED_OPACITY = 0.4;
/** The Redo half's arrival and departure. Layout animations skip under Reduce Motion by default. */
const REDO_ENTERING = FadeIn.duration(150);
const REDO_EXITING = FadeOut.duration(150);
const PILL_LAYOUT = LinearTransition.duration(150);

type SprayEditorBottomBarProps = {
  counts: SprayEditorCounts;
  /** Maybes are currently drawn. Drives the Hide / Show row. */
  showMaybes: boolean;
  /** The target reviews detector finds at all. False drops the two maybe rows. */
  canReviewMaybes: boolean;
  canUndo: boolean;
  /** Something was undone and nothing edited since: the pill grows a Redo half. */
  canRedo: boolean;
  /** Add mode is on: the + turns into a check that leaves it, like the banner's Done. */
  adding: boolean;
  /** Read-only, or a commit is in flight: every control is disabled. */
  locked: boolean;
  primaryLabel: string;
  primaryLoading: boolean;
  /** A Corners outline is half placed: Finish or undo it before publishing. */
  primaryBlocked: boolean;
  /** The holds are saved: the capsule turns into a checkmark for the hand-over. */
  celebrating: boolean;
  bottomInset: number;
  onUndo: () => void;
  onRedo: () => void;
  /** Enter add mode (outline the holds the scan missed), or leave it while `adding`. */
  onAdd: () => void;
  onKeepMaybes: () => void;
  onToggleMaybes: () => void;
  onStartOver: () => void;
  onPrimary: () => void;
  /** The count capsule's menu is open. Held by the screen, so Esc can close it. */
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
};

/**
 * The editor's floating bottom bar: the Undo | Redo pill, the count capsule,
 * Add, and the one button that saves and publishes.
 *
 * Undo and Redo share one split glass pill, and the Redo half only slides in
 * while there is something to redo — so the resting bar is the same three
 * controls it always was, and the redo arrow appears exactly when it means
 * something.
 *
 * Add is the one tool with its own button, because it is the one a climber goes
 * looking for: every scan misses a few small holds, and a tap on bare wall only
 * picks or puts down rings — it never adds. It is a glass + rather than a
 * labelled button so the row fits a 375pt phone however long the counts read.
 *
 * The capsule is the only place the wall's numbers are said, and it doubles as
 * the menu for the three wall-wide actions — so the bar stays four controls
 * however much the editor can do. The menu is an inline glass card rather than
 * a native sheet, because a sheet would cover the very board the climber is
 * deciding about.
 */
export const SprayEditorBottomBar = React.memo(function SprayEditorBottomBar({
  counts,
  showMaybes,
  canReviewMaybes,
  canUndo,
  canRedo,
  adding,
  locked,
  primaryLabel,
  primaryLoading,
  primaryBlocked,
  celebrating,
  bottomInset,
  onUndo,
  onRedo,
  onAdd,
  onKeepMaybes,
  onToggleMaybes,
  onStartOver,
  onPrimary,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
}: SprayEditorBottomBarProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();

  return (
    <View pointerEvents="box-none" style={[styles.root, { bottom: bottomInset + SPRAY_BAR_GUTTER }]}>
      {menuOpen && !locked ? (
        <SprayEditorMenu
          counts={counts}
          showMaybes={showMaybes}
          canReviewMaybes={canReviewMaybes}
          onKeepMaybes={onKeepMaybes}
          onToggleMaybes={onToggleMaybes}
          onStartOver={onStartOver}
          onClose={onCloseMenu}
        />
      ) : null}

      <View pointerEvents="box-none" style={styles.row}>
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

        <SprayCountCapsule
          counts={counts}
          showMaybes={showMaybes}
          celebrating={celebrating}
          locked={locked}
          onPress={onToggleMenu}
          expanded={menuOpen}
        />

        <GlassIconButton
          iconName="plus"
          secondaryIconName="check.small"
          active={adding}
          iconColor={adding ? brandColors.primary : systemColors.label}
          fallbackColor={systemColors.fill}
          size={SPRAY_BAR_HEIGHT}
          onPress={onAdd}
          disabled={locked}
          accessibilityLabel={adding ? t('sprayEditor.banner.done') : t('sprayEditor.bar.addA11y')}
        />
      </View>
      <Button
        title={primaryLabel}
        variant="filled"
        size="large"
        onPress={onPrimary}
        loading={primaryLoading}
        disabled={locked || primaryBlocked || counts.on === 0}
        minHeight={SPRAY_BAR_HEIGHT}
      />
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
    gap: spacing[2],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
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
