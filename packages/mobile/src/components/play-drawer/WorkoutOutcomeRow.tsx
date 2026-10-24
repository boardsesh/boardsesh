// The player's small row during a timed workout block (#6231, #5380): Fell and
// Sent, one tap each. It takes the whole row, the way the busy-wall question
// does, so both buttons are big enough to hit with chalky fingers between goes.
// `resolveActionBarLayout` decides when it shows; the buttons it displaces wait
// in ⋯.
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PressableSurface } from '../PressableSurface';
import { LargeContentViewer } from '../LargeContentViewer';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { androidRipple, spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { glassSize } from '../../theme/layout';
import { useWorkoutOneTap } from './use-workout-one-tap';
import type { WorkoutOutcomeTarget } from './workout-outcome';

type WorkoutOutcomeRowProps = {
  target: WorkoutOutcomeTarget;
  /** The player's Log ascent opener, for a spray climb nobody has sent yet. */
  onOpenLogSheet: () => void;
};

export const WorkoutOutcomeRow = memo(function WorkoutOutcomeRow({ target, onOpenLogSheet }: WorkoutOutcomeRowProps) {
  const { t } = useTranslation('session');
  const { brandColors, systemColors, radii } = useTheme();
  const { onFell, onSent } = useWorkoutOneTap(target, onOpenLogSheet);
  const fellLabel = t('playView.workoutOutcome.fell');
  const sentLabel = t('playView.workoutOutcome.sent');

  return (
    <View style={styles.row} testID="workout-outcome-row">
      <PressableSurface
        testID="workout-outcome-fell"
        onPress={onFell}
        accessibilityRole="button"
        accessibilityLabel={fellLabel}
        accessibilityHint={t('playView.workoutOutcome.fellHint')}
        style={[styles.button, { backgroundColor: systemColors.fill, borderRadius: radii.button }]}
      >
        <LargeContentViewer title={fellLabel} onActivate={onFell}>
          <Text
            variant="subheadline"
            color={systemColors.label}
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={styles.label}
          >
            {fellLabel}
          </Text>
        </LargeContentViewer>
      </PressableSurface>
      <PressableSurface
        testID="workout-outcome-sent"
        onPress={onSent}
        accessibilityRole="button"
        accessibilityLabel={sentLabel}
        accessibilityHint={t('playView.workoutOutcome.sentHint')}
        android_ripple={androidRipple(brandColors.onPrimary)}
        style={[styles.button, { backgroundColor: brandColors.primaryFill, borderRadius: radii.button }]}
      >
        <LargeContentViewer title={sentLabel} onActivate={onSent}>
          <Text
            variant="subheadline"
            color={brandColors.onPrimary}
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={styles.label}
          >
            {sentLabel}
          </Text>
        </LargeContentViewer>
      </PressableSurface>
    </View>
  );
});

const styles = StyleSheet.create({
  // Fills the second row it replaces. The host row is horizontal, so `flex`
  // only widens this; the height comes from the buttons.
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  // The row's own control height, so the row stays its usual 64 pt and the
  // board does not move when a timed block starts.
  button: {
    flex: 1,
    height: glassSize.inline,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[4],
    overflow: 'hidden',
  },
  label: {
    fontWeight: '600',
    flexShrink: 1,
  },
});
