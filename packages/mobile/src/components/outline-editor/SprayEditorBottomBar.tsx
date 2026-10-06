import React, { useCallback, useMemo, useState } from 'react';
import { Alert, StyleSheet, View, type ColorValue } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition, ZoomIn } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { GlassIconButton } from '../GlassIconButton';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import type { SprayEditorCounts } from './spray-hold-editor-reducer';
import { SPRAY_BAR_GUTTER, SPRAY_BAR_HEIGHT } from './spray-photo-frame';
import { SprayCountCrossfade } from './SprayCountCrossfade';
import { springs } from '../../theme/animations';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Diameter of the dashed dot that ties the capsule's maybe line to the dashed rings. */
const MAYBE_DOT_SIZE = 8;
/** The checkmark the capsule turns into once the holds are saved. */
const CHECK_SIZE = 26;
/** The undo and redo glyphs, the size `GlassIconButton` draws its own. */
const HISTORY_ICON_SIZE = 22;
/** Dimmed opacity for Undo with nothing to undo, matching a disabled glass button. */
const DISABLED_OPACITY = 0.4;
/** The Redo half's arrival and departure. Layout animations skip under Reduce Motion by default. */
const REDO_ENTERING = FadeIn.duration(150);
const REDO_EXITING = FadeOut.duration(150);
const PILL_LAYOUT = LinearTransition.duration(150);
// Built-in, so Reduce Motion (the system setting) skips it: the checkmark
// simply appears.
const CHECK_ENTERING = ZoomIn.springify()
  .damping(springs.bouncy.damping)
  .stiffness(springs.bouncy.stiffness)
  .mass(springs.bouncy.mass);

/**
 * The wall's numbers as one line — "212 holds · 38 maybes", or just the holds
 * while there are no maybes on screen. What a screen reader hears for the
 * capsule and for the wall itself.
 */
export function sprayCountSummary(t: Translate, counts: SprayEditorCounts, showMaybes: boolean): string {
  const holdsLabel = t('sprayEditor.bar.holds', { count: counts.on });
  if (counts.maybes === 0 || !showMaybes) return holdsLabel;
  return t('sprayEditor.bar.withMaybes', {
    holds: holdsLabel,
    maybes: t('sprayEditor.bar.maybes', { count: counts.maybes }),
  });
}

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
}: SprayEditorBottomBarProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  const holdsLabel = t('sprayEditor.bar.holds', { count: counts.on });
  const maybesLabel = counts.maybes > 0 && showMaybes ? t('sprayEditor.bar.maybes', { count: counts.maybes }) : null;
  const countLabel = celebrating ? t('sprayEditor.bar.saved') : sprayCountSummary(t, counts, showMaybes);

  const toggleMenu = useCallback(() => setMenuOpen((open) => !open), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  const menuActions = useMemo(() => {
    const keepMaybes = () => {
      setMenuOpen(false);
      onKeepMaybes();
    };
    const toggleMaybes = () => {
      setMenuOpen(false);
      onToggleMaybes();
    };
    const startOver = () => {
      setMenuOpen(false);
      Alert.alert(t('sprayEditor.startOver.title'), t('sprayEditor.startOver.body'), [
        { text: t('sprayEditor.startOver.cancel'), style: 'cancel' },
        { text: t('sprayEditor.startOver.confirm'), style: 'destructive', onPress: onStartOver },
      ]);
    };
    return { keepMaybes, toggleMaybes, startOver };
  }, [onKeepMaybes, onToggleMaybes, onStartOver, t]);

  return (
    <View pointerEvents="box-none" style={[styles.root, { bottom: bottomInset + SPRAY_BAR_GUTTER }]}>
      {menuOpen && !locked ? (
        <View style={styles.menu}>
          <GlassSurface glassEffectStyle="regular" borderRadius={borderRadius.xl} style={StyleSheet.absoluteFill} />
          {canReviewMaybes && counts.maybes > 0 && showMaybes ? (
            <Button
              title={t('sprayEditor.menu.keepMaybes')}
              variant="text"
              over="surface"
              onPress={menuActions.keepMaybes}
            />
          ) : null}
          {canReviewMaybes && counts.maybes > 0 ? (
            <Button
              title={showMaybes ? t('sprayEditor.menu.hideMaybes') : t('sprayEditor.menu.showMaybes')}
              variant="text"
              over="surface"
              onPress={menuActions.toggleMaybes}
            />
          ) : null}
          <Button
            title={t('sprayEditor.menu.startOver')}
            variant="text"
            role="destructive"
            over="surface"
            onPress={menuActions.startOver}
          />
          <Button title={t('sprayEditor.menu.close')} variant="text" role="cancel" over="surface" onPress={closeMenu} />
        </View>
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

        <PressableSurface
          testID="spray-count-capsule"
          onPress={toggleMenu}
          disabled={locked}
          feedback="scale"
          accessibilityRole="button"
          accessibilityLabel={countLabel}
          accessibilityHint={t('sprayEditor.bar.menuHint')}
          accessibilityState={{ expanded: menuOpen, disabled: locked }}
          style={styles.capsule}
        >
          <GlassSurface
            glassEffectStyle="regular"
            fallbackColor={systemColors.fill}
            borderRadius={glassSize.capsule / 2}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          {celebrating ? (
            <Animated.View entering={CHECK_ENTERING} style={styles.check}>
              <Icon name="checkmark.circle.fill" size={CHECK_SIZE} color={brandColors.primary} />
            </Animated.View>
          ) : (
            <>
              {/* The primary action has its own row, leaving the translated
                  counts the space between the two fixed-size icon buttons. */}
              <SprayCountCrossfade
                text={holdsLabel}
                value={counts.on}
                variant={maybesLabel ? 'subheadline' : 'headline'}
                color={systemColors.label}
                style={[styles.capsuleText, styles.holdsText]}
              />
              {maybesLabel ? (
                <View style={styles.maybeRow}>
                  <View style={[styles.maybeDot, { borderColor: brandColors.accent }]} />
                  <SprayCountCrossfade
                    text={maybesLabel}
                    value={counts.maybes}
                    variant="caption2"
                    color={systemColors.secondaryLabel}
                    style={styles.capsuleText}
                  />
                </View>
              ) : null}
            </>
          )}
        </PressableSurface>

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
  capsule: {
    flex: 1,
    minWidth: 0,
    height: glassSize.capsule,
    borderRadius: glassSize.capsule / 2,
    overflow: 'hidden',
    justifyContent: 'center',
    paddingHorizontal: spacing[3],
  },
  capsuleText: {
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  holdsText: {
    fontWeight: '600',
  },
  check: {
    alignSelf: 'center',
  },
  maybeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[1],
  },
  maybeDot: {
    width: MAYBE_DOT_SIZE,
    height: MAYBE_DOT_SIZE,
    borderRadius: MAYBE_DOT_SIZE / 2,
    borderWidth: 1.5,
    borderStyle: 'dashed',
  },
  menu: {
    alignSelf: 'center',
    minWidth: 220,
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    paddingVertical: spacing[1],
    paddingHorizontal: spacing[2],
    gap: spacing[1],
  },
});
