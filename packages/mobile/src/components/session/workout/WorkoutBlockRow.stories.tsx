import { useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { I18nextProvider } from 'react-i18next';
import type { StoryModule } from '../../../dev/stories/types';
import { StoryVariant } from '../../../dev/stories/StoryCanvas';
import { i18n } from '../../../lib/i18n';
import { Card } from '../../Card';
import { spacing } from '../../../theme/tokens';
import { WorkoutBlockRow } from './WorkoutBlockRow';
import { WorkoutHeadlineChip } from './WorkoutHeadlineChip';
import { WorkoutSummarySection } from './WorkoutSummarySection';
import { WorkoutSyncingNote } from './WorkoutSyncingNote';
import type { WorkoutStageView } from './types';
import {
  COOL_DOWN,
  FOUR_BY_FOUR,
  LONG_STAGE,
  OTHER_KIND_STAGES,
  STORY_HEADLINE,
  STORY_HEADLINE_MORE,
  STORY_HEADLINE_TWO,
  STORY_WORKOUT,
  WARM_UP,
} from './workout-story-fixtures';

// The pieces of a finished workout (#6903), every state on one screen: the
// block rows for each kind, opened and closed; German, whose tallies can't share
// a line with the block's name; the feed card's line; and the "still saving"
// note.

function Rows({ stages, expanded = [] }: { stages: WorkoutStageView[]; expanded?: string[] }) {
  return (
    <Card style={styles.card}>
      {stages.map((stage, index) => (
        <WorkoutBlockRow
          key={stage.id}
          stage={stage}
          separator={index < stages.length - 1}
          initiallyExpanded={expanded.includes(stage.id)}
        />
      ))}
    </Card>
  );
}

/** Draws its children in another app locale, leaving the app's own alone. */
function InLocale({ lng, children }: { lng: string; children: ReactNode }) {
  const instance = useMemo(() => i18n.cloneInstance({ lng }), [lng]);
  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}

const stories: StoryModule = {
  title: 'Session / Workout blocks',
  stories: {
    rows: {
      name: 'Block rows, every kind',
      render: () => (
        <>
          <StoryVariant label="warm-up, 4x4 open, cool-down open">
            <Rows stages={[WARM_UP, FOUR_BY_FOUR, COOL_DOWN]} expanded={[FOUR_BY_FOUR.id, COOL_DOWN.id]} />
          </StoryVariant>
          <StoryVariant label="on the minute, pyramid open, limit, a newer kind">
            <Rows stages={OTHER_KIND_STAGES} expanded={['stage-pyramid']} />
          </StoryVariant>
        </>
      ),
    },
    german: {
      name: 'German: tallies wrap under the name',
      render: () => (
        <InLocale lng="de">
          <View style={styles.stack}>
            <WorkoutSummarySection workout={STORY_WORKOUT} initiallyExpandedStageId={FOUR_BY_FOUR.id} />
            <StoryVariant label="long names, 7A+ target">
              <Rows stages={[LONG_STAGE]} expanded={[LONG_STAGE.id]} />
            </StoryVariant>
            <StoryVariant label="feed line">
              <WorkoutHeadlineChip headline={STORY_HEADLINE_TWO} />
            </StoryVariant>
            <WorkoutSyncingNote pendingTicks={22} />
          </View>
        </InLocale>
      ),
    },
    chips: {
      name: 'Feed card line',
      render: () => (
        <>
          <StoryVariant label="one main block">
            <WorkoutHeadlineChip headline={STORY_HEADLINE} />
          </StoryVariant>
          <StoryVariant label="two main blocks">
            <WorkoutHeadlineChip headline={STORY_HEADLINE_TWO} />
          </StoryVariant>
          <StoryVariant label="more">
            <WorkoutHeadlineChip headline={STORY_HEADLINE_MORE} />
          </StoryVariant>
        </>
      ),
    },
    syncing: {
      name: 'Still saving',
      render: () => (
        <>
          <StoryVariant label="online">
            <WorkoutSyncingNote pendingTicks={22} />
          </StoryVariant>
          <StoryVariant label="one climb">
            <WorkoutSyncingNote pendingTicks={1} />
          </StoryVariant>
          <StoryVariant label="offline">
            <WorkoutSyncingNote pendingTicks={22} offline />
          </StoryVariant>
        </>
      ),
    },
  },
};

const styles = StyleSheet.create({
  card: {
    paddingVertical: spacing[1],
  },
  stack: {
    gap: spacing[5],
  },
});

export default stories;
