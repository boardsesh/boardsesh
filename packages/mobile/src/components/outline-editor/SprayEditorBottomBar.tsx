import React, { useCallback, useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Button } from '../Button';
import { GlassIconButton } from '../GlassIconButton';
import { GlassSurface } from '../GlassSurface';
import { PressableSurface } from '../PressableSurface';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import type { SprayEditorCounts } from './spray-hold-editor-reducer';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Diameter of the dashed dot that ties the capsule's maybe line to the dashed rings. */
const MAYBE_DOT_SIZE = 8;

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

/** Height of the bar's tallest member. The screen reserves this plus the gutter below it. */
export const SPRAY_BAR_HEIGHT = glassSize.standard;
/** Gap between the bar and the bottom safe area. */
export const SPRAY_BAR_GUTTER = spacing[2];

type SprayEditorBottomBarProps = {
  counts: SprayEditorCounts;
  /** Maybes are currently drawn. Drives the Hide / Show row. */
  showMaybes: boolean;
  /** The target reviews detector finds at all. False drops the two maybe rows. */
  canReviewMaybes: boolean;
  canUndo: boolean;
  /** Read-only, or a commit is in flight: every control is disabled. */
  locked: boolean;
  primaryLabel: string;
  primaryLoading: boolean;
  bottomInset: number;
  onUndo: () => void;
  onKeepMaybes: () => void;
  onToggleMaybes: () => void;
  onStartOver: () => void;
  onPrimary: () => void;
};

/**
 * The editor's floating bottom bar: Undo, the count capsule, and the one button
 * that saves and publishes.
 *
 * The capsule is the only place the wall's numbers are said, and it doubles as
 * the menu for the three wall-wide actions — so the bar stays three controls
 * however much the editor can do. The menu is an inline glass card rather than
 * a native sheet, because a sheet would cover the very board the climber is
 * deciding about.
 */
export const SprayEditorBottomBar = React.memo(function SprayEditorBottomBar({
  counts,
  showMaybes,
  canReviewMaybes,
  canUndo,
  locked,
  primaryLabel,
  primaryLoading,
  bottomInset,
  onUndo,
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
  const countLabel = sprayCountSummary(t, counts, showMaybes);

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
              over="content"
              onPress={menuActions.keepMaybes}
            />
          ) : null}
          {canReviewMaybes && counts.maybes > 0 ? (
            <Button
              title={showMaybes ? t('sprayEditor.menu.hideMaybes') : t('sprayEditor.menu.showMaybes')}
              variant="text"
              over="content"
              onPress={menuActions.toggleMaybes}
            />
          ) : null}
          <Button
            title={t('sprayEditor.menu.startOver')}
            variant="text"
            role="destructive"
            over="content"
            onPress={menuActions.startOver}
          />
          <Button title={t('sprayEditor.menu.close')} variant="text" role="cancel" over="content" onPress={closeMenu} />
        </View>
      ) : null}

      <View pointerEvents="box-none" style={styles.row}>
        <GlassIconButton
          iconName="undo"
          iconColor={systemColors.label}
          fallbackColor={systemColors.fill}
          size={SPRAY_BAR_HEIGHT}
          onPress={onUndo}
          disabled={!canUndo || locked}
          accessibilityLabel={t('sprayEditor.bar.undo')}
        />

        <PressableSurface
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
          {/* Two short lines rather than one long one, so the capsule never
              truncates beside Undo and the primary button on a 375pt phone. */}
          <Text
            variant={maybesLabel ? 'subheadline' : 'headline'}
            color={systemColors.label}
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={[styles.capsuleText, styles.holdsText]}
          >
            {holdsLabel}
          </Text>
          {maybesLabel ? (
            <View style={styles.maybeRow}>
              <View style={[styles.maybeDot, { borderColor: brandColors.accent }]} />
              <Text
                variant="caption2"
                color={systemColors.secondaryLabel}
                numberOfLines={1}
                maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
                style={styles.capsuleText}
              >
                {maybesLabel}
              </Text>
            </View>
          ) : null}
        </PressableSurface>

        <Button
          title={primaryLabel}
          variant="filled"
          size="large"
          onPress={onPrimary}
          loading={primaryLoading}
          disabled={locked || counts.on === 0}
          minHeight={SPRAY_BAR_HEIGHT}
        />
      </View>
    </View>
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
