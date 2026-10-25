// The player's small row during a timed workout block (#6231, #5380): Fell and
// Sent, one tap each. It takes the whole row, the way the busy-wall question
// does, so both buttons are big enough to hit with chalky fingers between goes.
// `resolveActionBarLayout` decides when it shows; the buttons it displaces wait
// in ⋯.
//
// The row also says what a tap did. The player is a native modal on iOS and the
// root toast draws behind it, so the confirmation lives here: the tapped button
// reads "Try logged" (or Flash / Send) for a moment, and a failure takes the row
// until it is read.
//
// Just after the wall leaves the timed block the player holds the row for the
// climb it left (`use-workout-outcome-hold.ts`). The buttons still log there,
// so their hints and saved lines name that climb: the board already shows the
// next one.
import { memo } from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { TickStatus } from '@boardsesh/play-view';
import { PressableSurface } from '../PressableSurface';
import { LargeContentViewer } from '../LargeContentViewer';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { androidRipple, spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { glassSize } from '../../theme/layout';
import { useWorkoutOneTap, type WorkoutOneTapNotice } from './use-workout-one-tap';
import type { WorkoutOutcomeTarget } from './workout-outcome';

type WorkoutOutcomeRowProps = {
  target: WorkoutOutcomeTarget;
  /**
   * Set while the row is held for `target` after the wall left it: when it
   * left. Null while `target` is the climb on the wall.
   */
  wallLeftAtMs?: number | null;
  /** The player's Log ascent opener, for a spray climb nobody has sent yet. */
  onOpenLogSheet: () => void;
};

type SavedNotice = Extract<WorkoutOneTapNotice, { kind: 'saved' }>;

export const WorkoutOutcomeRow = memo(function WorkoutOutcomeRow({
  target,
  wallLeftAtMs = null,
  onOpenLogSheet,
}: WorkoutOutcomeRowProps) {
  const { t } = useTranslation('session');
  const { brandColors, systemColors, radii } = useTheme();
  const { onFell, onSent, notice, dismissNotice } = useWorkoutOneTap(target, onOpenLogSheet, wallLeftAtMs);
  // While held, the climb the buttons log is no longer the one on screen.
  const held = wallLeftAtMs !== null;
  const onScreenQueueItemUuid = held ? null : target.queueItemUuid;

  if (notice?.kind === 'message') {
    return (
      <View style={styles.row} testID="workout-outcome-row">
        <PressableSurface
          testID="workout-outcome-message"
          onPress={dismissNotice}
          accessibilityRole="button"
          accessibilityLabel={notice.message}
          accessibilityHint={t('playView.workoutOutcome.messageHint')}
          style={[styles.message, { backgroundColor: systemColors.fill, borderRadius: radii.button }]}
        >
          <Icon
            name={notice.tone === 'error' ? 'error' : 'info'}
            size={18}
            color={notice.tone === 'error' ? brandColors.error : brandColors.primary}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          />
          <Text
            variant="footnote"
            color={systemColors.label}
            numberOfLines={2}
            adjustsFontSizeToFit
            minimumFontScale={0.8}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={styles.messageText}
          >
            {notice.message}
          </Text>
        </PressableSurface>
      </View>
    );
  }

  const fellLabel = t('playView.workoutOutcome.fell');
  const sentLabel = t('playView.workoutOutcome.sent');
  const fellHint = held
    ? t('playView.workoutOutcome.fellHintPrevious', { name: target.climb.name })
    : t('playView.workoutOutcome.fellHint');
  const sentHint = held
    ? t('playView.workoutOutcome.sentHintPrevious', { name: target.climb.name })
    : t('playView.workoutOutcome.sentHint');
  const fellSavedLabel = notice?.status === 'attempt' ? savedNoticeLabel(t, notice, onScreenQueueItemUuid) : null;
  const sentSavedLabel =
    notice && notice.status !== 'attempt' ? savedNoticeLabel(t, notice, onScreenQueueItemUuid) : null;

  return (
    <View style={styles.row} testID="workout-outcome-row">
      <PressableSurface
        testID="workout-outcome-fell"
        onPress={onFell}
        accessibilityRole="button"
        accessibilityLabel={fellLabel}
        accessibilityHint={fellHint}
        style={[styles.button, { backgroundColor: systemColors.fill, borderRadius: radii.button }]}
      >
        <OutcomeButtonLabel
          label={fellLabel}
          savedLabel={fellSavedLabel}
          color={systemColors.label}
          onActivate={onFell}
        />
      </PressableSurface>
      <PressableSurface
        testID="workout-outcome-sent"
        onPress={onSent}
        accessibilityRole="button"
        accessibilityLabel={sentLabel}
        accessibilityHint={sentHint}
        android_ripple={androidRipple(brandColors.onPrimary)}
        style={[styles.button, { backgroundColor: brandColors.primaryFill, borderRadius: radii.button }]}
      >
        <OutcomeButtonLabel
          label={sentLabel}
          savedLabel={sentSavedLabel}
          color={brandColors.onPrimary}
          onActivate={onSent}
        />
      </PressableSurface>
    </View>
  );
});

/**
 * What a saved go reads on its button. Short while the climb it was logged on is
 * the one on screen; the full sentence, naming the climb, when the go was for
 * the climb the wall just left (`onScreenQueueItemUuid` is null while the row is
 * held for that climb).
 */
function savedNoticeLabel(t: TFunction<'session'>, notice: SavedNotice, onScreenQueueItemUuid: string | null): string {
  if (notice.queueItemUuid !== onScreenQueueItemUuid) return notice.message;
  return shortSavedLabel(t, notice.status);
}

function shortSavedLabel(t: TFunction<'session'>, status: TickStatus): string {
  if (status === 'attempt') return t('playView.workoutOutcome.attemptLoggedLabel');
  if (status === 'flash') return t('playView.workoutOutcome.flashLoggedLabel');
  return t('playView.workoutOutcome.sendLoggedLabel');
}

type OutcomeButtonLabelProps = {
  label: string;
  /** Set for a moment after this button's go saved; shown in place of `label`. */
  savedLabel: string | null;
  color: ColorValue;
  onActivate: () => void;
};

/**
 * The button's words. The accessibility label stays Fell / Sent while the saved
 * line shows: a screen reader already heard the full sentence, and the button
 * still does what it says.
 */
function OutcomeButtonLabel({ label, savedLabel, color, onActivate }: OutcomeButtonLabelProps) {
  const shownLabel = savedLabel ?? label;
  return (
    <LargeContentViewer title={shownLabel} onActivate={onActivate} style={styles.labelBox}>
      {savedLabel !== null ? (
        <Icon name="success" size={16} color={color} maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE} />
      ) : null}
      <Text
        variant="subheadline"
        color={color}
        numberOfLines={1}
        // A saved line runs longer than Fell / Sent in some languages, and it
        // names the climb after the wall moved: shrink a little before cutting.
        adjustsFontSizeToFit={savedLabel !== null}
        minimumFontScale={0.75}
        maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
        style={styles.label}
      >
        {shownLabel}
      </Text>
    </LargeContentViewer>
  );
}

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
  labelBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[1],
    maxWidth: '100%',
  },
  label: {
    fontWeight: '600',
    flexShrink: 1,
  },
  // The buttons' height, so a message in the row never moves the board.
  message: {
    flex: 1,
    height: glassSize.inline,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[4],
    overflow: 'hidden',
  },
  messageText: {
    flexShrink: 1,
  },
});
