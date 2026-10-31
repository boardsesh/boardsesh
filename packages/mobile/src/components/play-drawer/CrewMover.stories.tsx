import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import type { StoryModule } from '../../dev/stories/types';
import { resolveCurrentClimbMoverName } from '../../lib/current-climb-mover';
import { spacing } from '../../theme/tokens';
import { BusyWallQuestionGroup } from './BusyWallQuestionGroup';
import { resolveBusyWallHolder, resolveBusyWallQuestion } from './busy-wall-question';
import { formatBusyWallCaption } from './busy-wall-question-text';
import { formatCrewPutUp, resolveCrewPutUp } from './crew-put-up-store';
import { PlayListContext } from './PlayListContext';

const noop = () => {};
const CURRENT: ClimbQueueItem = {
  uuid: 'crew-mover-slot',
  addedByUser: { id: 'account-alex', username: 'Alex' },
  climb: {
    uuid: 'crew-mover-climb',
    name: 'Moonlight Sonata',
    setter_username: 'Setter',
    frames: '',
    angle: 40,
    ascensionist_count: 1,
    difficulty: '6A',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
  },
};
const MOVER_NAME = resolveCurrentClimbMoverName({
  currentChangedBy: 'participant-sam',
  participantId: 'participant-me',
  sessionUsers: [{ id: 'participant-sam', username: 'Sam' }],
});

function CrewMoverExample() {
  const { t } = useTranslation('session');
  const named = resolveCrewPutUp(CURRENT, MOVER_NAME);
  const generic = resolveCrewPutUp(CURRENT, null);
  const question = resolveBusyWallQuestion({
    holder: resolveBusyWallHolder({
      mover: MOVER_NAME ? { name: MOVER_NAME, avatarUrl: null } : null,
      wallClimbUuid: CURRENT.climb.uuid,
      currentClimbUuid: CURRENT.climb.uuid,
    }),
    wallClimbName: CURRENT.climb.name,
    selfHoldsBoard: true,
    ready: true,
  });
  return (
    <View style={styles.stack}>
      <StoryVariant label="Alex queued it; Sam put it up">
        <StorySurface>
          <PlayListContext parts={null} caption={named ? formatCrewPutUp(named, t) : null} />
        </StorySurface>
      </StoryVariant>
      <StoryVariant label="Mover unavailable: generic wording">
        <StorySurface>
          <PlayListContext parts={null} caption={generic ? formatCrewPutUp(generic, t) : null} />
        </StorySurface>
      </StoryVariant>
      <StoryVariant label="The current busy-wall controls name Sam too">
        <StorySurface>
          <View style={styles.stack}>
            <PlayListContext parts={null} caption={formatBusyWallCaption(question, t)} />
            <BusyWallQuestionGroup model={question} onKeep={noop} onPut={noop} />
          </View>
        </StorySurface>
      </StoryVariant>
    </View>
  );
}

const stories: StoryModule = {
  title: 'Play drawer / Crew mover',
  stories: { attribution: { name: 'Name the mover, preserve the fallback', render: () => <CrewMoverExample /> } },
};
export default stories;
const styles = StyleSheet.create({ stack: { gap: spacing[5] } });
