import { useCallback, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { PressableSurface } from '../PressableSurface';
import { Text } from '../Text';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useQueueActions, useQueueData } from '../../providers/queue-provider';
import { QueueDataContext } from '../../providers/queue/queue-contexts';
import { useSearchClimbs } from '../../lib/graphql/hooks';
import { climbToQueueItem } from '../../lib/climb-to-queue-item';
import type { StoryModule } from '../../dev/stories/types';
import { QueueSheet, type QueueSheetHandle } from './QueueSheet';
import { useQueueSheetHandlers } from './use-queue-sheet-handlers';
import { glassSize } from '../../theme/layout';

const STORY_BOARD = { boardName: 'kilter' as const, layoutId: 8, sizeId: 25, setIds: '26,27,28,29', angle: 35 };

/** Real native presenters; duplicate occurrences make a history row without a server. */
function HistoryTickStory() {
  const liveQueue = useQueueData();
  const { setCurrentClimb } = useQueueActions();
  const { openLogAscent, openPlayDrawer, getClimbActions } = useDrawerHost();
  const queueRef = useRef<QueueSheetHandle>(null);
  const { data: sampleClimbs } = useSearchClimbs({
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    angle: 35,
    page: 0,
    pageSize: 30,
    sortBy: 'ascents',
    sortOrder: 'desc',
    boulders: true,
    crossAngleStats: false,
  });
  const sampleClimb = sampleClimbs?.climbs[0];
  const current = useMemo(() => (sampleClimb ? climbToQueueItem(sampleClimb) : undefined), [sampleClimb]);
  const storyQueue = useMemo(() => {
    if (!current) return liveQueue;
    const history = { ...current, uuid: 'story-queue-tick-history' };
    const playing = { ...current, uuid: 'story-queue-tick-current' };
    return { ...liveQueue, queue: [history, playing], currentClimbQueueItem: playing, historyCount: 1 };
  }, [current, liveQueue]);
  const closeQueue = useCallback(() => queueRef.current?.dismiss(), []);
  const dismissQueueAndWait = useCallback(
    () => queueRef.current?.dismissAndWait() ?? Promise.resolve({ status: 'dismissed' as const }),
    [],
  );
  const handlers = useQueueSheetHandlers({
    setCurrentClimb,
    openPlayDrawer,
    getClimbActions,
    openLogAscent,
    storedBoardConfig: STORY_BOARD,
    sessionId: null,
    requestCloseQueueSheet: closeQueue,
    dismissQueueSheetAndWait: dismissQueueAndWait,
  });
  const openQueue = useCallback(() => queueRef.current?.present(), []);
  return (
    <View>
      <Text>{current ? current.climb.name : 'Loading a sample climb…'}</Text>
      <Text>Toggle history in the queue, then tap Tick. The sample uses Kilter layout 8 at 35°.</Text>
      <PressableSurface
        style={styles.action}
        accessibilityLabel="Open queue with history"
        onPress={openQueue}
        disabled={!current}
      >
        <Text>Open queue with history</Text>
      </PressableSurface>
      <QueueDataContext.Provider value={storyQueue}>
        <QueueSheet
          ref={queueRef}
          board={STORY_BOARD}
          onClose={closeQueue}
          onClimbPress={handlers.handleClimbPress}
          onOpenActions={handlers.handleOpenActions}
          onSuggestionPress={handlers.handleSuggestionPress}
          onTickHistory={handlers.handleTickHistory}
        />
      </QueueDataContext.Provider>
    </View>
  );
}

const stories: StoryModule = {
  title: 'Queue / Tick above the queue',
  stories: {
    historyTick: { name: 'Tick above the native queue', render: () => <HistoryTickStory /> },
  },
};
export default stories;

const styles = StyleSheet.create({ action: { minHeight: glassSize.inline, justifyContent: 'center' } });
