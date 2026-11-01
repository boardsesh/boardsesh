// "Workout done" over the board (#6291): the moment the last climb of the
// workout meets its block's rule, what the workout came to (sent, tried,
// skipped), and two ways on: See your workout (the Record tab's "Your workout"
// card) or Done.
//
// The end-of-list card's pattern (TrackEndCard): an anchored card over the
// board, not a sheet, modal for assistive tech. The scrim and the card share
// one container that carries `accessibilityViewIsModal`, focus lands on the
// title when it opens, and Android hardware back closes it. Unlike the rest
// card it is modal, because it ends the workout: nothing under it is the next
// thing to do.
//
// The numbers are this phone's (`WorkoutRunnerReadout.totals`): only blocks
// with something logged here count, so a block climbed on another phone never
// reads as skipped. With nothing logged here at all it says so instead of
// showing three zeros.

import { memo, useEffect, useRef } from 'react';
import { BackHandler, StyleSheet, View, type ViewInstance } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { PressableSurface } from '../PressableSurface';
import { Button } from '../Button';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, overlays, shadows, spacing } from '../../theme/tokens';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import type { WorkoutClimbTally } from '../../lib/workout-runner-readout';
import { useAnnounceBodyFocus } from './use-announce-body-focus';

/** The end-of-list card's width: the button labels fit in German at Dynamic Type. */
const CARD_MAX_WIDTH = 340;
/** Over the board art and its overlays; the drawer's sub-sheets present above it. */
const CARD_Z = 20;
const CARD_FADE_MS = 150;

type WorkoutDoneCardProps = {
  totals: WorkoutClimbTally;
  /** Leaves the player for the Record tab, where the workout's blocks and Add a block are. */
  onSeeWorkout: () => void;
  onDismiss: () => void;
};

function WorkoutDoneCardImpl({ totals, onSeeWorkout, onDismiss }: WorkoutDoneCardProps) {
  const { t } = useTranslation('session');
  const { variant, systemColors, brandColors, m3SurfaceContainers, materialElevation } = useTheme();
  const reduceMotion = useReducedMotion();
  const titleRef = useRef<ViewInstance>(null);
  useAnnounceBodyFocus(titleRef, true);

  // Android hardware back closes the card before it closes the player.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onDismiss();
      return true;
    });
    return () => subscription.remove();
  }, [onDismiss]);

  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  const cardSurface = isMaterial
    ? [{ backgroundColor: m3SurfaceContainers.high }, materialElevation.level2]
    : [
        {
          backgroundColor: systemColors.elevatedSurface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: systemColors.separator,
        },
        shadows.md,
      ];

  const loggedHere = totals.sent + totals.tried > 0;
  const stats = [
    {
      id: 'sent',
      count: totals.sent,
      label: t('mobile.workoutRunner.doneStatSent'),
      spoken: t('mobile.workoutRunner.tallySent', { count: totals.sent }),
    },
    {
      id: 'tried',
      count: totals.tried,
      label: t('mobile.workoutRunner.doneStatTried'),
      spoken: t('mobile.workoutRunner.tallyTried', { count: totals.tried }),
    },
    {
      id: 'skipped',
      count: totals.skipped,
      label: t('mobile.workoutRunner.doneStatSkipped'),
      spoken: t('mobile.workoutRunner.tallySkipped', { count: totals.skipped }),
    },
  ];

  return (
    <View accessibilityViewIsModal style={styles.modalRegion} testID="workout-done-card">
      {/* Tapping beside the card closes it, as Done does. Labelled, so
          assistive tech has a way out that is not the hardware back button. */}
      <PressableSurface
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel={t('mobile.workoutRunner.doneClose')}
        style={styles.scrim}
        testID="workout-done-card-scrim"
      />
      <Animated.View
        entering={reduceMotion ? undefined : FadeIn.duration(CARD_FADE_MS)}
        style={[styles.card, ...cardSurface]}
      >
        <View ref={titleRef} accessible accessibilityRole="header">
          <Text variant="title3" color={systemColors.label} style={styles.centered}>
            {t('mobile.workoutRunner.done')}
          </Text>
        </View>
        {loggedHere ? (
          <View style={styles.stats} testID="workout-done-card-stats">
            {stats.map(({ id, count, label, spoken }) => (
              <View key={id} style={styles.stat} accessible accessibilityLabel={spoken}>
                <Text variant="title2" color={id === 'sent' ? brandColors.primary : systemColors.label} numeric>
                  {count}
                </Text>
                <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.centered} numberOfLines={2}>
                  {label}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centered}>
            {t('mobile.workoutRunner.doneNothingLogged')}
          </Text>
        )}
        {/* One centred stack, as on the end-of-list card: the way on first,
            Done under it, both spanning the card. */}
        <Button
          title={t('mobile.workoutRunner.seeWorkout')}
          variant="filled"
          size="medium"
          onPress={onSeeWorkout}
          testID="workout-done-card-see-workout"
          style={styles.fullWidth}
        />
        <Button
          title={t('mobile.workoutRunner.doneClose')}
          variant="tonal"
          size="medium"
          over="glass"
          onPress={onDismiss}
          testID="workout-done-card-done"
          style={styles.fullWidth}
        />
      </Animated.View>
    </View>
  );
}

export const WorkoutDoneCard = memo(WorkoutDoneCardImpl);

const styles = StyleSheet.create({
  modalRegion: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: CARD_Z,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[4],
  },
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: overlays.scrim,
  },
  card: {
    width: '100%',
    maxWidth: CARD_MAX_WIDTH,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[4],
    gap: spacing[3],
    alignItems: 'center',
  },
  centered: {
    textAlign: 'center',
  },
  stats: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    justifyContent: 'space-around',
    gap: spacing[2],
  },
  stat: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  fullWidth: {
    alignSelf: 'stretch',
  },
});
