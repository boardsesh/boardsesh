import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import type { StoryModule } from '../../dev/stories/types';

import { spacing } from '../../theme/tokens';
import { RestTimerClockView, RestTimerHeroClockView, RestTimerPillView, WorkoutStartPill } from './RestTimerViews';
import { timerDisplay } from '../../dev/stories/RestTimerScene';

// The rest timer's readouts in one state each: the floating pill, the drawer
// header's compact pill, the Record tab's clock and the sheet's hero (#5396).
//
// Each view receives a fixed timer snapshot; stories never mutate the app timer.

const STORY_REST_SECONDS = 60;

const noop = () => {};

function EveryReadout({ secondsLeft }: { secondsLeft: number }) {
  const display = timerDisplay(secondsLeft, STORY_REST_SECONDS);
  return (
    <View style={styles.stack}>
      <Readout label="pill">
        <RestTimerPillView display={display} onTogglePause={noop} onReset={noop} onPress={noop} />
      </Readout>
      <Readout label="drawer header pill">
        <RestTimerPillView display={display} onTogglePause={noop} onReset={noop} onPress={noop} compact />
      </Readout>
      <Readout label="record tab clock">
        <RestTimerClockView display={display} variant="headline" />
      </Readout>
      <Readout label="sheet hero">
        <RestTimerHeroClockView display={display} />
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
    preparedWorkout: {
      name: 'Prepared workout, before its first climb',
      render: () => (
        <View style={styles.stack}>
          <Readout label="pill">
            <WorkoutStartPill onPress={noop} firstClimbName="Crimp City" />
          </Readout>
          <Readout label="drawer header pill">
            <WorkoutStartPill onPress={noop} firstClimbName="Crimp City" compact />
          </Readout>
          <Readout label="all climbs removed">
            <WorkoutStartPill onPress={noop} firstClimbName={null} />
          </Readout>
        </View>
      ),
    },
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
