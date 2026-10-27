import { useEffect } from 'react';
import { useRouter, type Href } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import type { SessionSummary } from '@boardsesh/shared-schema';
import type { StoryModule } from '../../dev/stories/types';
import { Text } from '../Text';
import { sessionSummaryQueryKey } from '../../lib/graphql/query-keys';
import { SessionSummaryContent } from './SessionSummaryContent';
import { FOUR_BY_FOUR, STORY_SUMMARY, STORY_SUMMARY_UNSYNCED, STORY_WORKOUT } from './workout/workout-story-fixtures';

// The post-session summary (#6903). The workout stories draw the recap from
// props, full screen, so they need no route and leave nothing on top. The route
// stories put a summary in the query cache under a story-only session id, pin it
// so the screen never refetches it, and open the real modal: a plain session
// reads exactly as before, since the workout seam returns nothing yet.

// The tester's screen: a session ended with nothing on the server for it.
const EMPTY_SUMMARY: SessionSummary = {
  ...STORY_SUMMARY_UNSYNCED,
  sessionId: 'story-summary-empty',
  durationMinutes: null,
};

function OpenSummary({ summary }: { summary: SessionSummary }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  useEffect(() => {
    const key = sessionSummaryQueryKey(summary.sessionId);
    queryClient.setQueryDefaults(key, { staleTime: Infinity, gcTime: Infinity, retry: false });
    queryClient.setQueryData(key, { sessionSummary: summary });
    router.push(`/record/summary?sessionId=${summary.sessionId}` as Href);
  }, [queryClient, router, summary]);
  return <Text variant="footnote">Opening the summary…</Text>;
}

const stories: StoryModule = {
  title: 'Session / Summary',
  stories: {
    workout: {
      name: 'After a workout: warm-up, 4x4 at V4, cool-down',
      layout: 'fullscreen',
      render: () => (
        <SessionSummaryContent
          summary={STORY_SUMMARY}
          storeReviewWillPrompt
          workout={STORY_WORKOUT}
          initiallyExpandedStageId={FOUR_BY_FOUR.id}
        />
      ),
    },
    workoutSaving: {
      name: 'After a workout, 22 ticks still saving',
      layout: 'fullscreen',
      render: () => (
        <SessionSummaryContent
          summary={STORY_SUMMARY_UNSYNCED}
          storeReviewWillPrompt
          workout={STORY_WORKOUT}
          pendingTicks={22}
          initiallyExpandedStageId={FOUR_BY_FOUR.id}
        />
      ),
    },
    workoutOffline: {
      name: 'After a workout, offline with 22 ticks on the phone',
      layout: 'fullscreen',
      render: () => (
        <SessionSummaryContent
          summary={STORY_SUMMARY_UNSYNCED}
          storeReviewWillPrompt
          workout={STORY_WORKOUT}
          pendingTicks={22}
          offline
        />
      ),
    },
    plain: {
      name: 'The same session with no workout (real route)',
      render: () => <OpenSummary summary={{ ...STORY_SUMMARY, sessionId: 'story-summary-plain' }} />,
    },
    empty: {
      name: 'A session with nothing on the server (real route)',
      render: () => <OpenSummary summary={EMPTY_SUMMARY} />,
    },
  },
};

export default stories;
