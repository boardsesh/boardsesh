// The rest card over the board during a timed workout block (#6291, #5380,
// #6231): what this rest is ("Set 2 done"), the rest counting down, what comes
// after it ("Next: Crimp City · V5", or "Then rep 2 of 4 · Set 1 of 4" back on
// the same climb), and one action: Skip rest, or Go now. The wording is
// `resolveWorkoutRestCard`'s; this lays it out.
//
// NOT modal, unlike the end-of-list and workout-done cards: the climber rests
// with the player open, and the board, its swipes, the header and the Fell /
// Sent row all stay live under and around it. The card sits low on the board,
// just above its Reset zoom corner, the region around it lets every touch
// through, and it never moves screen-reader focus.
//
// A rest that keeps the climb up (Go now) ends with the climber going again,
// not with the wall moving, so nothing else would take the card away: it goes
// once the rest has run out, out of the way of that go.
//
// The summary is one element to a screen reader ("Set 2 done. Rest timer, 2:58
// left. Next: Crimp City, V5"), with spoken lines of its own where the visible
// ones lean on "·" or a short form, so it is a leaf that reads the live display
// for that sentence and re-renders once a second; nothing above it does. The
// digits are the `RestTimerClock` leaf, the same clock as the pill.

import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '../Button';
import { Text } from '../Text';
import { RestTimerClock, restTimerClockAccessibilityLabel, useRestTimerDisplay } from '../queue-control/RestTimerPill';
import { useTheme } from '../../providers/theme-provider';
import { useDisplayGrade } from '../../hooks/use-display-grade';
import { workoutStageName } from '../../lib/workout-run-readout';
import type { WallDriverRole } from '../../lib/session-timer/driver-rule';
import { borderRadius, shadows, spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import type { WorkoutRestCardCaption, WorkoutRestCardHeading, WorkoutRestCardModel } from './workout-runner-cards';

/** Room for a German heading beside the clock, narrow enough to leave the board's sides in view on a tablet. */
const CARD_MAX_WIDTH = 400;
/** Over the board art and its overlays, like the end-of-list card. */
const CARD_Z = 20;
const CARD_FADE_MS = 150;
/** Between the parts of the spoken sentence, as the Record tab's rest line joins its own. */
const SPOKEN_SEPARATOR = '. ';
/**
 * The card's bottom, clear of the board's Reset zoom control: that sits in the
 * board's bottom-right corner, 12 up (SwipeBoardCarousel's `resetZoomWrapper`)
 * and `glassSize.mini` tall, and on a phone the card spans the board's width.
 * Above it, the control stays in view and tappable while a rest runs.
 */
const RESET_ZOOM_BOTTOM_INSET = 12;
const CARD_BOTTOM = RESET_ZOOM_BOTTOM_INSET + glassSize.mini + spacing[2];

/** A line on the card, and how a screen reader says it. */
export type RestCardLine = { text: string; spoken: string };

type WorkoutRestCardProps = {
  model: WorkoutRestCardModel;
  /** The board the player draws, so the next climb's grade reads in its own system. */
  boardName: string;
  /** This phone's place in the crew (`useSessionTimerDriver`), for who moves the wall when it is not this phone. */
  role: WallDriverRole;
  pacerDisplayName: string | null;
  onSkipRest: () => void;
  onGoNow: () => void;
};

function WorkoutRestCardImpl(props: WorkoutRestCardProps) {
  return props.model.action === 'goNow' ? <RestCardUntilRestRunsOut {...props} /> : <RestCardBody {...props} />;
}

export const WorkoutRestCard = memo(WorkoutRestCardImpl);

/**
 * A Go now card, until its rest has run out. Reads the live display, so it
 * re-renders once a second; the memoised body under it does not.
 */
function RestCardUntilRestRunsOut(props: WorkoutRestCardProps) {
  const { phase } = useRestTimerDisplay();
  if (phase === 'exceeded') return null;
  return <RestCardBody {...props} />;
}

const RestCardBody = memo(function RestCardBody({
  model,
  boardName,
  role,
  pacerDisplayName,
  onSkipRest,
  onGoNow,
}: WorkoutRestCardProps) {
  const { t } = useTranslation('session');
  const { variant, systemColors, m3SurfaceContainers, materialElevation } = useTheme();
  const reduceMotion = useReducedMotion();
  const { resolveGrade } = useDisplayGrade();

  // The end-of-list card's surface, in each look.
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

  const heading = restCardHeadingText(model.heading, t);
  const caption = model.caption
    ? restCardCaptionText(model.caption, t, {
        gradeOf: (caption) => resolveGrade(caption.item.climb, boardName).label,
        role,
        pacerDisplayName,
      })
    : null;
  const nextName = model.caption?.kind === 'nextClimb' ? model.caption.item.climb.name : null;

  return (
    <View pointerEvents="box-none" style={styles.region} testID="workout-rest-card">
      <Animated.View
        entering={reduceMotion ? undefined : FadeIn.duration(CARD_FADE_MS)}
        style={[styles.card, ...cardSurface]}
      >
        <RestCardSummary heading={heading} caption={caption} />
        {model.action === 'skipRest' ? (
          // Tonal and told it sits on glass, as the end-of-list card's second
          // button: a bordered capsule that reads as tappable on the opaque card.
          <Button
            title={t('mobile.workoutRunner.skipRest')}
            accessibilityLabel={
              nextName
                ? t('mobile.workoutRunner.skipRestAccessibilityLabel', { name: nextName })
                : t('mobile.workoutRunner.skipRest')
            }
            variant="tonal"
            size="small"
            over="glass"
            onPress={onSkipRest}
            testID="workout-rest-card-skip"
            style={styles.action}
          />
        ) : model.action === 'goNow' ? (
          <Button
            title={t('mobile.workoutRunner.goNow')}
            variant="tonal"
            size="small"
            over="glass"
            onPress={onGoNow}
            testID="workout-rest-card-go-now"
            style={styles.action}
          />
        ) : null}
      </Animated.View>
    </View>
  );
});

/**
 * The heading, the clock and the caption, as one sentence to a screen reader.
 * A leaf: it reads the live display, so only it re-renders per second.
 */
function RestCardSummary({ heading, caption }: { heading: RestCardLine; caption: RestCardLine | null }) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const display = useRestTimerDisplay();
  const spokenParts = [heading.spoken, restTimerClockAccessibilityLabel(display, t)];
  if (caption) spokenParts.push(caption.spoken);
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={spokenParts.join(SPOKEN_SEPARATOR)}
      style={styles.summary}
      testID="workout-rest-card-summary"
    >
      <View style={styles.headingRow}>
        <Text variant="headline" color={systemColors.label} style={styles.heading} numberOfLines={2}>
          {heading.text}
        </Text>
        <RestTimerClock variant="title2" />
      </View>
      {caption ? (
        <Text
          variant="subheadline"
          color={systemColors.secondaryLabel}
          numberOfLines={2}
          testID="workout-rest-card-caption"
        >
          {caption.text}
        </Text>
      ) : null}
    </View>
  );
}

/** The same words to see and to hear. */
function sameLine(text: string): RestCardLine {
  return { text, spoken: text };
}

/** Literal keys, so the i18n analyser sees each one. */
export function restCardHeadingText(heading: WorkoutRestCardHeading, t: TFunction<'session'>): RestCardLine {
  switch (heading.kind) {
    case 'rest':
      return sameLine(t('mobile.workoutRunner.restLabel'));
    case 'nextBeat':
      return sameLine(t('mobile.workoutRunner.nextBeatLabel'));
    case 'paused':
      return sameLine(t('mobile.workoutRunner.timerPausedLabel'));
    case 'setDone':
      return sameLine(t('mobile.workoutRunner.restCardSetDone', { set: heading.set }));
    case 'stageDone': {
      const stage = workoutStageName(heading.stage, t, heading.isCoolDown);
      return {
        text: t('mobile.workoutRunner.restCardStageDone', { stage }),
        spoken: t('mobile.workoutRunner.restCardStageDoneAccessibilityLabel', { stage }),
      };
    }
  }
}

type CaptionContext = {
  gradeOf: (caption: Extract<WorkoutRestCardCaption, { kind: 'nextClimb' }>) => string | null;
  role: WallDriverRole;
  pacerDisplayName: string | null;
};

/**
 * What follows the rest. The lines that join two facts with "·", or shorten
 * "rep", have spoken forms with a comma and the full word, as the runner's
 * other spoken lines do.
 */
export function restCardCaptionText(
  caption: WorkoutRestCardCaption,
  t: TFunction<'session'>,
  { gradeOf, role, pacerDisplayName }: CaptionContext,
): RestCardLine {
  switch (caption.kind) {
    case 'nextRep': {
      const values = { rep: caption.rep, reps: caption.reps, set: caption.set, sets: caption.sets };
      return {
        text: t('mobile.workoutRunner.restCardThenRep', values),
        spoken: t('mobile.workoutRunner.restCardThenRepAccessibilityLabel', values),
      };
    }
    case 'tryAgain':
      return {
        text: t('mobile.workoutRunner.restCardThenTryAgain', { number: caption.tryNumber }),
        spoken: t('mobile.workoutRunner.restCardThenTryAgainAccessibilityLabel', { number: caption.tryNumber }),
      };
    case 'nextClimb': {
      const name = caption.item.climb.name;
      const grade = gradeOf(caption);
      if (!grade) return sameLine(t('mobile.workoutRunner.restCardNextClimbName', { name }));
      return {
        text: t('mobile.workoutRunner.restCardNextClimb', { name, grade }),
        spoken: t('mobile.workoutRunner.restCardNextClimbAccessibilityLabel', { name, grade }),
      };
    }
    case 'nextStage':
      return sameLine(
        t('mobile.workoutRunner.restCardNextStage', {
          stage: workoutStageName(caption.stage, t, caption.isCoolDown),
        }),
      );
    case 'movedByHolder':
      // The crew's own lines, so the card and the rest timer sheet agree.
      if (role === 'unheld') return sameLine(t('mobile.restTimer.crew.autoAdvanceUnheld'));
      return sameLine(
        pacerDisplayName
          ? t('mobile.restTimer.crew.autoAdvanceByName', { name: pacerDisplayName })
          : t('mobile.restTimer.crew.autoAdvanceByCrewmate'),
      );
  }
}

const styles = StyleSheet.create({
  // Low on the board, above its Reset zoom corner. Lets every touch beside the
  // card through to the board, so swipes and pinches keep working around it.
  region: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: CARD_BOTTOM,
    zIndex: CARD_Z,
    alignItems: 'center',
  },
  // The action drops under the summary when the two don't fit side by side
  // (large text, a narrow phone or pane, German), instead of squeezing the
  // climb's name. The line breaks on the summary's base size, so that is its
  // own text's width (`summary`), never a fixed one.
  card: {
    width: '100%',
    maxWidth: CARD_MAX_WIDTH,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: spacing[3],
    rowGap: spacing[2],
  },
  // No `flexBasis` (and no `flex`): the base size is the summary's own width,
  // its longest line unwrapped, capped at the card's. A fixed basis (it was 180)
  // fit beside the button at 375 pt even at the largest text, so the button
  // never dropped and the caption broke mid-phrase in half the card. Grows into
  // the line it gets.
  summary: {
    flexGrow: 1,
    flexShrink: 1,
    gap: 2,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    columnGap: spacing[3],
  },
  heading: {
    flexShrink: 1,
  },
  action: {
    flexShrink: 0,
    marginLeft: 'auto',
  },
});
