import React, { useMemo } from 'react';
import { Alert, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { ZoomIn } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { springs } from '../../theme/animations';
import type { SprayEditorCounts } from './spray-hold-editor-reducer';
import { SprayCountCrossfade } from './SprayCountCrossfade';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Diameter of the dashed dot that ties the capsule's maybe line to the dashed rings. */
const MAYBE_DOT_SIZE = 8;
/** The checkmark the capsule turns into once the holds are saved. */
const CHECK_SIZE = 26;
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

type SprayCountCapsuleProps = {
  counts: SprayEditorCounts;
  showMaybes: boolean;
  /** The holds are saved: the capsule turns into a checkmark for the hand-over. */
  celebrating: boolean;
  locked: boolean;
  /** Opens the wall-wide menu. Omitted, the capsule only shows the numbers. */
  onPress?: () => void;
  /** The menu it opens is showing. */
  expanded?: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * The only place the wall's numbers are said: a glass capsule with the hold
 * count (and the maybes under it while any show), which turns into a checkmark
 * once the holds are saved. Shared by the phone editor's top-left corner, where
 * it is also the button for the wall-wide menu (which opens downward from it),
 * and the iPad's primary cluster, where that menu lives on the tool rail
 * instead.
 */
export const SprayCountCapsule = React.memo(function SprayCountCapsule({
  counts,
  showMaybes,
  celebrating,
  locked,
  onPress,
  expanded = false,
  style,
}: SprayCountCapsuleProps) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors } = useTheme();

  const holdsLabel = t('sprayEditor.bar.holds', { count: counts.on });
  const maybesLabel = counts.maybes > 0 && showMaybes ? t('sprayEditor.bar.maybes', { count: counts.maybes }) : null;
  const countLabel = celebrating ? t('sprayEditor.bar.saved') : sprayCountSummary(t, counts, showMaybes);
  const pressable = onPress != null;

  return (
    <PressableSurface
      testID="spray-count-capsule"
      onPress={onPress}
      disabled={locked || !pressable}
      feedback="scale"
      accessibilityRole={pressable ? 'button' : 'text'}
      accessibilityLabel={countLabel}
      accessibilityHint={pressable ? t('sprayEditor.bar.menuHint') : undefined}
      accessibilityState={pressable ? { expanded, disabled: locked } : undefined}
      style={[styles.capsule, style]}
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
  );
});

type SprayEditorMenuProps = {
  counts: SprayEditorCounts;
  showMaybes: boolean;
  /** The target reviews detector finds at all. False drops the two maybe rows. */
  canReviewMaybes: boolean;
  /** Keep all / Hide / Show maybes. The iPad rail has its own buttons for them, so it passes false. */
  includeMaybeRows?: boolean;
  onKeepMaybes: () => void;
  onToggleMaybes: () => void;
  onStartOver: () => void;
  /** Close the menu. Every row closes it before it acts. */
  onClose: () => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * The wall-wide actions: keep all maybes, hide or show them, and start over
 * (behind a confirm, though it has an undo too). An inline glass card rather
 * than a native sheet, because a sheet would cover the very board the climber
 * is deciding about.
 */
export const SprayEditorMenu = React.memo(function SprayEditorMenu({
  counts,
  showMaybes,
  canReviewMaybes,
  includeMaybeRows = true,
  onKeepMaybes,
  onToggleMaybes,
  onStartOver,
  onClose,
  style,
}: SprayEditorMenuProps) {
  const { t } = useTranslation('boards');

  const actions = useMemo(() => {
    const keepMaybes = () => {
      onClose();
      onKeepMaybes();
    };
    const toggleMaybes = () => {
      onClose();
      onToggleMaybes();
    };
    const startOver = () => {
      onClose();
      Alert.alert(t('sprayEditor.startOver.title'), t('sprayEditor.startOver.body'), [
        { text: t('sprayEditor.startOver.cancel'), style: 'cancel' },
        { text: t('sprayEditor.startOver.confirm'), style: 'destructive', onPress: onStartOver },
      ]);
    };
    return { keepMaybes, toggleMaybes, startOver };
  }, [onClose, onKeepMaybes, onToggleMaybes, onStartOver, t]);

  const maybeRows = includeMaybeRows && canReviewMaybes && counts.maybes > 0;
  return (
    <View style={[styles.menu, style]}>
      <GlassSurface glassEffectStyle="regular" borderRadius={borderRadius.xl} style={StyleSheet.absoluteFill} />
      {maybeRows && showMaybes ? (
        <Button title={t('sprayEditor.menu.keepMaybes')} variant="text" over="surface" onPress={actions.keepMaybes} />
      ) : null}
      {maybeRows ? (
        <Button
          title={showMaybes ? t('sprayEditor.menu.hideMaybes') : t('sprayEditor.menu.showMaybes')}
          variant="text"
          over="surface"
          onPress={actions.toggleMaybes}
        />
      ) : null}
      <Button
        title={t('sprayEditor.menu.startOver')}
        variant="text"
        role="destructive"
        over="surface"
        onPress={actions.startOver}
      />
      <Button title={t('sprayEditor.menu.close')} variant="text" role="cancel" over="surface" onPress={onClose} />
    </View>
  );
});

const styles = StyleSheet.create({
  // Sized to its numbers. The iPad's primary cluster stretches it.
  capsule: {
    minWidth: glassSize.capsule,
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
