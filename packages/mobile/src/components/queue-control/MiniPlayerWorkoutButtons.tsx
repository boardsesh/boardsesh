// One-tap Fell / Sent on the MiniPlayer in a timed workout block (#6940). The
// taps are the player's own (`useWorkoutOneTap`): Fell logs one try, Sent a
// flash or a send, one tap at a time, and a tap just after the wall moved logs
// for the climb it left. Over the tab screens the root toast is in view, so a
// failure is a toast; a saved go marks the tapped button with a check for
// `SAVED_NOTICE_MS`, with the success haptic and the full sentence spoken. The
// guard and the check are shared with every other Fell / Sent on screen
// (`workout-one-tap-store.ts`), the player's row included.
import { memo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { PressableSurface } from '../PressableSurface';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useWorkoutOneTap } from '../play-drawer/use-workout-one-tap';
import type { WorkoutOutcomeShown } from '../play-drawer/use-workout-outcome-hold';
import type { MiniPlayerWorkoutButton } from './mini-player-controls';

type MiniPlayerWorkoutButtonsProps = {
  /** Left to right, as `resolveMiniPlayerControls` placed them: Fell and Sent, or Sent alone. */
  buttonIds: readonly MiniPlayerWorkoutButton[];
  /** The climb the taps log for, and whether the bar is holding it after the wall left. */
  shown: WorkoutOutcomeShown;
  slotWidth: number;
  rowHeight: number;
};

/**
 * Each button sits in a slot keyed by its id, so a change of buttons swaps
 * slots inside the live row and the row itself never remounts (UIKit snapshots
 * the platter). UIKit mounts the bar once per placement, regular and inline, at
 * the same time, so this component runs twice with no state between the two.
 * Everything a tap depends on lives in `workout-one-tap-store.ts` instead: a
 * tap on the open bar's Sent and one on the minimized bar's Sent within the
 * guard log one go, and both bars show the same check.
 */
export const MiniPlayerWorkoutButtons = memo(function MiniPlayerWorkoutButtons({
  buttonIds,
  shown,
  slotWidth,
  rowHeight,
}: MiniPlayerWorkoutButtonsProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();
  const { openLogAscent } = useDrawerHost();
  const { target, wallLeftAtMs } = shown;
  // A spray climb nobody has sent needs a grade: Sent opens Log ascent on it.
  const openLogSheet = useCallback(() => {
    const { climb } = target;
    openLogAscent({
      climb,
      climbUuid: climb.uuid,
      climbName: climb.name,
      boardName: target.boardName,
      angle: target.angle,
      isMirror: target.isMirror,
      isBenchmark: climb.benchmark_difficulty != null,
      baseAscensionistCount: climb.ascensionist_count ?? 0,
      layoutId: target.layoutId,
      sizeId: target.sizeId,
      setIds: target.setIds,
      sessionId: target.sessionId,
      consensusGradeName: climb.difficulty ?? undefined,
    });
  }, [openLogAscent, target]);
  const { onFell, onSent, notice } = useWorkoutOneTap(target, openLogSheet, wallLeftAtMs, { messages: 'toast' });
  const held = wallLeftAtMs !== null;
  const savedStatus = notice?.kind === 'saved' ? notice.status : null;

  return (
    <>
      {buttonIds.map((buttonId) => {
        const isFell = buttonId === 'fell';
        const saved = savedStatus !== null && (savedStatus === 'attempt') === isFell;
        const label = isFell ? t('playView.workoutOutcome.fell') : t('playView.workoutOutcome.sent');
        const hint = isFell
          ? held
            ? t('playView.workoutOutcome.fellHintPrevious', { name: target.climb.name })
            : t('playView.workoutOutcome.fellHint')
          : held
            ? t('playView.workoutOutcome.sentHintPrevious', { name: target.climb.name })
            : t('playView.workoutOutcome.sentHint');
        return (
          <View
            key={buttonId}
            testID={`mini-player-slot-${buttonId}`}
            style={[styles.slot, { width: slotWidth, height: rowHeight }]}
          >
            <PressableSurface
              testID={`mini-player-workout-${buttonId}`}
              onPress={isFell ? onFell : onSent}
              feedback="opacity"
              hitSlop={4}
              accessibilityRole="button"
              // Fell / Sent while the check shows too: the full sentence was
              // announced, and the button still does what it says.
              accessibilityLabel={label}
              accessibilityHint={hint}
              style={[styles.action, { width: slotWidth, height: slotWidth }]}
            >
              <Icon
                maxFontSizeMultiplier={1}
                name={saved ? 'checkmark.circle.fill' : isFell ? 'ascent.attempt' : 'tick'}
                size={24}
                color={saved ? brandColors.success : isFell ? systemColors.label : brandColors.primary}
              />
            </PressableSurface>
          </View>
        );
      })}
    </>
  );
});

const styles = StyleSheet.create({
  slot: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  action: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
