import { useStoryBottomInset } from '../stories/use-story-bottom-inset';
import { formatGrade } from '@boardsesh/play-view';
import type { SessionDetail } from '@boardsesh/shared-schema';
import type { FlashListRef } from '@shopify/flash-list';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PressableSurface } from '../../components/PressableSurface';
import { SectionHeader } from '../../components/SectionHeader';
import { SessionAnalyticsSectionView } from '../../components/session/SessionAnalyticsSectionView';
import { SessionDetailView } from '../../components/session/SessionDetailView';
import { SessionNotesCard, SessionSummaryCardView } from '../../components/session/SessionSummaryCardView';
import { SessionTickRowView } from '../../components/session/SessionTickRowView';
import {
  WorkoutBlockSectionRow,
  WorkoutListSectionLabel,
  WorkoutPlannedClimbRow,
  WorkoutSetRowView,
} from '../../components/session/workout/WorkoutClimbsListRowsView';
import type { SessionWorkoutView } from '../../components/session/workout/types';
import { buildWorkoutClimbRows, type WorkoutClimbsRow } from '../../components/session/workout/workout-climb-rows';
import { AvatarGroup } from '../../components/you/AvatarGroup';
import { FeedSocialRowView } from '../../components/you/FeedSocialRowView';
import { gradeBadgeColor } from '../../components/you/profile-chart-colors';
import { sessionTickToClimb } from '../../lib/session-tick-mapping';
import { renderStoryClimbContent, StoryClimbArtObserverProvider, StoryClimbThumbnail } from '../stories/StoryClimbRow';
import type { StoryRenderControls } from '../stories/types';
import { readFlashListViewport, useVisibleArtReadiness } from '../stories/use-visible-art-readiness';
import { STORY_BOARD, STORY_CLIMBS } from './climbs';
const noop = () => {};
const wrapClimbRow: import('../../components/session/SessionTickRowView').SessionTickRowViewProps['wrapClimbRow'] = (
  children,
  accessibilityLabel,
  style,
) => (
  <PressableSurface onPress={noop} accessibilityLabel={accessibilityLabel} style={style}>
    {children}
  </PressableSurface>
);
const formatStoryGrade = (grade: string | null | undefined, board?: string | null) =>
  formatGrade(grade, 'v-grade', board);
export function SessionClimbsStoryItem({ row }: { row: WorkoutClimbsRow }) {
  switch (row.type) {
    case 'tick': {
      const tick = {
        ...row.tick,
        frames: STORY_CLIMBS[0].frames,
        layoutId: STORY_BOARD.layoutId,
        renderBoard: {
          layoutId: STORY_BOARD.layoutId,
          sizeId: STORY_BOARD.sizeId,
          setIds: STORY_BOARD.setIds.split(',').map(Number),
        },
      };
      const climb = sessionTickToClimb(tick);
      return (
        <SessionTickRowView
          tick={tick}
          isMultiUser={false}
          onPress={noop}
          wrapClimbRow={wrapClimbRow}
          climbContent={climb ? renderStoryClimbContent({ ...STORY_BOARD, climb, showAscentStatus: false }) : undefined}
          gradeLabel={formatStoryGrade(row.tick.difficultyName, row.tick.boardType)}
          gradeColor={gradeBadgeColor(row.tick.difficultyName ?? '')}
        />
      );
    }
    case 'block':
      return <WorkoutBlockSectionRow stage={row.stage} />;
    case 'set':
      return (
        <WorkoutSetRowView
          climb={row.climb}
          setNumber={row.setNumber}
          repsPerSet={row.repsPerSet}
          tick={row.tick}
          thumbnail={
            <StoryClimbThumbnail
              {...STORY_BOARD}
              climbUuid={row.climb.climbUuid}
              frames={STORY_CLIMBS[0].frames}
              mirrored={row.climb.isMirror ?? false}
              size={{ width: 44, height: 56 }}
            />
          }
          onPress={noop}
        />
      );
    case 'climb':
      return <WorkoutPlannedClimbRow climb={row.climb} />;
    case 'offPlan':
      return <WorkoutListSectionLabel kind="offPlan" count={row.count} />;
    case 'crew':
      return <WorkoutListSectionLabel kind="crew" count={row.count} />;
  }
}
export const sessionRowAssetId = (row: WorkoutClimbsRow) =>
  row.type === 'tick' ? row.tick.climbUuid : row.type === 'set' ? row.climb.climbUuid : null;
export function SessionDetailStory({
  session,
  workout,
  onReady = noop,
  onError = noop,
}: { session: SessionDetail; workout: SessionWorkoutView } & Partial<StoryRenderControls>) {
  const { onDisplayed, onViewableItemsChanged, onInitialViewport } = useVisibleArtReadiness(sessionRowAssetId, onReady);
  const { t } = useTranslation('session');
  const insets = useSafeAreaInsets();
  const bottomInset = useStoryBottomInset();
  const [voted, setVoted] = useState(false);
  const toggleVote = useCallback(() => setVoted((previous) => !previous), []);
  const { rows } = useMemo(() => buildWorkoutClimbRows(session.ticks, workout), [session.ticks, workout]);
  const listRef = useRef<FlashListRef<WorkoutClimbsRow>>(null);
  const onLoad = useCallback(() => {
    if (listRef.current) onInitialViewport(readFlashListViewport(listRef.current, rows));
  }, [rows, onInitialViewport]);
  const renderItem = useCallback(({ item }: { item: WorkoutClimbsRow }) => <SessionClimbsStoryItem row={item} />, []);
  return (
    <StoryClimbArtObserverProvider onDisplayed={onDisplayed} onError={onError}>
      <SessionDetailView
        listRef={listRef}
        onLoad={onLoad}
        loading={false}
        found
        rows={rows}
        renderItem={renderItem}
        onViewableItemsChanged={onViewableItemsChanged}
        paddingBottom={bottomInset + 24}
        header={
          <View style={{ paddingTop: insets.top }}>
            <SessionSummaryCardView
              session={session}
              title="October 26, 2026"
              whenLine="Monday morning"
              displayHardestGrade={formatStoryGrade(session.hardestGrade, 'kilter')}
              avatars={<AvatarGroup participants={session.participants} size={32} interactive={false} />}
              social={
                <FeedSocialRowView
                  voted={voted}
                  count={session.upvotes + Number(voted)}
                  onVote={toggleVote}
                  commentCount={session.commentCount}
                  onOpenComments={noop}
                />
              }
            />
            <SessionAnalyticsSectionView
              gradeDistribution={session.gradeDistribution}
              boardName="kilter"
              formatAnyBoardGrade={formatStoryGrade}
            />
            <SessionNotesCard session={session} />
            <SectionHeader title={t('detail.climbsCount', { count: session.ticks.length })} />
          </View>
        }
      />
    </StoryClimbArtObserverProvider>
  );
}
