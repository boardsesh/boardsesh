import { useLayoutEffect, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import type { StoryModule } from '../../dev/stories/types';
import { nowMs } from '../../lib/clock';
import { armRestTimer, disarmRestTimer, noteRestTimerTick } from '../../lib/rest-timer-store';
import { getSetting, setSetting } from '../../settings';
import { spacing } from '../../theme/tokens';
import { RestTimerClock, RestTimerHeroClock, RestTimerPill } from './RestTimerPill';

// The rest timer's readouts in one state each: the floating pill, the drawer
// header's compact pill, the Record tab's clock and the sheet's hero (#5396).
//
// They read the live timer, not props, so each story arms the REAL rest timer
// with a 1:00 rest and the given time left, and disarms it when it leaves (an
// arm made in the app is lost, the same as Stop). The rest settings it pins are
// put back on the way out. Auto-advance is pinned off, so the app's scheduler
// counts down and buzzes but never moves a queue.
//
// The clock keeps running unless Metro froze it (EXPO_PUBLIC_SCREENSHOT_NOW):
// frozen, `finalCountdown` stays on 0:03 for a capture; live, it counts on from
// 0:03 into the overrun.

const STORY_REST_SECONDS = 60;

const noop = () => {};

function useStoryRestTimer(secondsLeft: number) {
  // A layout effect, so the first frame on screen is already armed.
  useLayoutEffect(() => {
    const previousSettings = {
      targetSeconds: getSetting('restTimerTargetSeconds'),
      mode: getSetting('restTimerMode'),
      autoAdvance: getSetting('restTimerAutoAdvance'),
    };
    setSetting('restTimerTargetSeconds', STORY_REST_SECONDS);
    setSetting('restTimerMode', 'afterTick');
    setSetting('restTimerAutoAdvance', false);

    const armedAtMs = nowMs();
    armRestTimer('afterTick', armedAtMs, null);
    const tickAtMs = armedAtMs - (STORY_REST_SECONDS - secondsLeft) * 1000;
    noteRestTimerTick(new Date(tickAtMs).toISOString(), 'afterTick', armedAtMs);

    return () => {
      disarmRestTimer();
      setSetting('restTimerTargetSeconds', previousSettings.targetSeconds);
      setSetting('restTimerMode', previousSettings.mode);
      setSetting('restTimerAutoAdvance', previousSettings.autoAdvance);
    };
  }, [secondsLeft]);
}

function EveryReadout({ secondsLeft }: { secondsLeft: number }) {
  useStoryRestTimer(secondsLeft);
  return (
    <View style={styles.stack}>
      <Readout label="pill">
        <RestTimerPill onPress={noop} />
      </Readout>
      <Readout label="drawer header pill">
        <RestTimerPill onPress={noop} compact />
      </Readout>
      <Readout label="record tab clock">
        <RestTimerClock variant="headline" />
      </Readout>
      <Readout label="sheet hero">
        <RestTimerHeroClock />
      </Readout>
    </View>
  );
}

function Readout({ label, children }: { label: string; children: ReactNode }) {
  return (
    <StoryVariant label={label}>
      <StorySurface>
        <View style={styles.row}>{children}</View>
      </StorySurface>
    </StoryVariant>
  );
}

const stories: StoryModule = {
  title: 'Rest timer / Readouts',
  stories: {
    finalCountdown: {
      name: 'Final countdown, 0:03 left of a 1:00 rest',
      render: () => <EveryReadout secondsLeft={3} />,
    },
    running: {
      name: 'Counting down, 0:20 left',
      render: () => <EveryReadout secondsLeft={20} />,
    },
    over: {
      name: 'Over the rest by 0:05',
      render: () => <EveryReadout secondsLeft={-5} />,
    },
  },
};

export default stories;

const styles = StyleSheet.create({
  stack: {
    gap: spacing[4],
  },
  row: {
    alignItems: 'center',
  },
});
