import { formatGrade } from '@boardsesh/play-view';
import type { SessionFeedItem } from '@boardsesh/shared-schema';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import type { WorkoutHeadlineView } from '../../components/session/workout/types';
import { AvatarGroup } from '../../components/you/AvatarGroup';
import { FeedSocialRowView } from '../../components/you/FeedSocialRowView';
import { SessionFeedCardView } from '../../components/you/SessionFeedCardView';
import { SessionFeedHeroView } from '../../components/you/SessionFeedHeroView';
import { SessionGradeStripView } from '../../components/you/SessionGradeStripView';
import { StoryBoard } from '../stories/StoryBoard';
import type { StoryRenderControls } from '../stories/types';
import { STORY_CLIMBS } from './climbs';

const noop = () => {};
const formatStoryGrade = (grade: string | null | undefined, board?: string | null) =>
  formatGrade(grade, 'v-grade', board);

/** Local interaction adapter for the same feed card used by Home and Sessions. */
export function SessionFeedStoryCard({
  session,
  workoutHeadline,
  onReady = noop,
  onError = noop,
}: {
  session: SessionFeedItem;
  workoutHeadline?: WorkoutHeadlineView;
  onReady?: StoryRenderControls['onReady'];
  onError?: StoryRenderControls['onError'];
}) {
  const { t } = useTranslation('session');
  const [voted, setVoted] = useState(false);
  const toggleVote = useCallback(() => setVoted((previous) => !previous), []);
  return (
    <SessionFeedCardView
      session={session}
      metaLine={[t('summary.minutes', { count: session.durationMinutes ?? 74 }), session.boardTypes[0]]
        .filter(Boolean)
        .join(' · ')}
      displayHardestGrade={formatStoryGrade(
        session.hardestGrade,
        session.hardestSend?.boardType ?? session.boardTypes[0],
      )}
      onPress={noop}
      workoutHeadline={workoutHeadline}
      avatars={<AvatarGroup participants={session.participants} size={36} interactive={false} />}
      gradeStrip={
        <SessionGradeStripView
          distribution={session.gradeDistribution}
          totalSends={session.totalSends}
          boardName={session.boardTypes[0]}
          formatAnyBoardGrade={formatStoryGrade}
        />
      }
      hero={
        session.hardestSend ? (
          <SessionFeedHeroView
            tick={session.hardestSend}
            displayGrade={formatStoryGrade(session.hardestSend.difficultyName, session.hardestSend.boardType)}
            media={
              <View style={{ width: 84, height: 104 }}>
                <StoryBoard climb={STORY_CLIMBS[0]} onReady={onReady} onError={onError} />
              </View>
            }
          />
        ) : undefined
      }
      social={
        <FeedSocialRowView
          voted={voted}
          count={session.upvotes + Number(voted)}
          commentCount={session.commentCount}
          onVote={toggleVote}
          onOpenComments={noop}
        />
      }
    />
  );
}
