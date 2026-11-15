import type { StoryModule } from '../../dev/stories/types';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import { RestTimerScene, timerDisplay } from '../../dev/stories/RestTimerScene';
import { RestTimerPillView, RestTimerHeroClockView } from './RestTimerViews';
import { RestTimerPacerCaptionView } from './RestTimerPacerCaption';
import type { WallDriverRole } from '../../lib/session-timer/driver-rule';
function CrewPills({ role }: { role: WallDriverRole }) {
  const display = timerDisplay();
  const pacer = <RestTimerPacerCaptionView role={role} pacerDisplayName="Sam" />;
  return (
    <>
      <StoryVariant label="Pill">
        <StorySurface>
          <RestTimerPillView
            display={display}
            onPress={() => {}}
            onTogglePause={() => {}}
            onReset={() => {}}
            pacer={pacer}
          />
        </StorySurface>
      </StoryVariant>
      <StoryVariant label="Drawer header pill">
        <StorySurface>
          <RestTimerPillView display={display} onPress={() => {}} onTogglePause={() => {}} onReset={() => {}} compact />
        </StorySurface>
      </StoryVariant>
      <StoryVariant label="Sheet clock">
        <StorySurface>
          <RestTimerHeroClockView display={display} pacer={pacer} />
        </StorySurface>
      </StoryVariant>
    </>
  );
}

const stories: StoryModule = {
  title: 'Rest timer / Crew',
  stories: {
    crewPassenger: {
      name: 'Pill and clock, Sam holds the board',
      render: () => <CrewPills role="passenger" />,
    },
    crewHolder: {
      name: 'Pill and clock, this phone holds the board',
      render: () => <CrewPills role="holder" />,
    },
    crewUnheld: {
      name: 'Pill and clock, nobody holds the board',
      render: () => <CrewPills role="unheld" />,
    },
    sheetCrewPassenger: {
      name: 'Rest timer sheet, Sam holds the board',
      readiness: 'explicit',
      render: ({ onReady }) => <RestTimerScene onReady={onReady} role="passenger" />,
    },
    sheetCrewHolder: {
      name: 'Rest timer sheet, this phone holds the board',
      readiness: 'explicit',
      render: ({ onReady }) => <RestTimerScene onReady={onReady} role="holder" />,
    },
  },
};

export default stories;
