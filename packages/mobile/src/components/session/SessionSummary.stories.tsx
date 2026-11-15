import type { SessionSummary } from '@boardsesh/shared-schema';
import { SessionSummaryStory } from '../../dev/fixtures/session-summary';
import type { StoryModule } from '../../dev/stories/types';
import { FOUR_BY_FOUR, STORY_SUMMARY, STORY_SUMMARY_UNSYNCED, STORY_WORKOUT } from './workout/workout-story-fixtures';
const EMPTY_SUMMARY: SessionSummary = {
  ...STORY_SUMMARY_UNSYNCED,
  sessionId: 'story-summary-empty',
  durationMinutes: null,
};

const stories: StoryModule = {
  title: 'Session / Summary',
  stories: {
    workout: {
      name: 'After a workout: warm-up, 4x4 at V4, cool-down',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => (
        <SessionSummaryStory
          {...controls}
          summary={STORY_SUMMARY}
          workout={STORY_WORKOUT}
          initiallyExpandedStageId={FOUR_BY_FOUR.id}
        />
      ),
    },
    workoutSaving: {
      name: 'After a workout, 22 ticks still saving',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => (
        <SessionSummaryStory
          {...controls}
          summary={STORY_SUMMARY_UNSYNCED}
          workout={STORY_WORKOUT}
          pendingTicks={22}
          initiallyExpandedStageId={FOUR_BY_FOUR.id}
        />
      ),
    },
    workoutOffline: {
      name: 'After a workout, offline with 22 ticks on the phone',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => (
        <SessionSummaryStory
          {...controls}
          summary={STORY_SUMMARY_UNSYNCED}
          workout={STORY_WORKOUT}
          pendingTicks={22}
          offline
        />
      ),
    },
    plain: {
      name: 'The same session with no workout ',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => (
        <SessionSummaryStory {...controls} summary={{ ...STORY_SUMMARY, sessionId: 'story-summary-plain' }} />
      ),
    },
    empty: {
      name: 'A session with nothing on the server ',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <SessionSummaryStory {...controls} summary={EMPTY_SUMMARY} />,
    },
  },
};

export default stories;
