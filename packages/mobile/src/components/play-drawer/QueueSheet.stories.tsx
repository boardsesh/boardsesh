import { useStorySheetPresentation } from '../../dev/stories/use-story-sheet-presentation';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BottomSheetModal } from '../sheet-presentation';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { StoryModule, StoryRenderControls } from '../../dev/stories/types';
import { useStoryBoardFixture } from '../../dev/stories/story-board-fixture';
import { StoryClimbArtObserverProvider, renderStoryClimbContent } from '../../dev/stories/StoryClimbRow';
import { climbToQueueItem } from '../../lib/climb-to-queue-item';
import { DEFAULT_CLIMB_ROW_DISPLAY } from '../../lib/climb-row-display';
import { QueueItemRowView, type QueueItemRowProps } from '../QueueItemRowView';
import { QueueListView, type QueueListRow } from './QueueListView';
import { QueueListBodyView } from './QueueListBodyView';
import { QueueSheetHeader } from './QueueSheetHeader';
import { QueueSheetView } from './QueueSheetView';

import { useVisibleArtReadiness } from '../../dev/stories/use-visible-art-readiness';

const assetId = (row: QueueListRow) =>
  row.type === 'off-queue' ? row.climb.uuid : 'item' in row ? (row.item.climb?.uuid ?? null) : null;
const noop = () => {};
const menu = {
  rows: [],
  onSelectIndex: noop,
  menuKey: 'story-queue',
  accessibilityActions: [],
  onAccessibilityAction: noop,
};
const StoryRow = memo(function StoryRow(props: QueueItemRowProps) {
  return <QueueItemRowView {...props} hasThumbnail menu={menu} ContentComponent={renderStoryClimbContent} />;
});

function QueueStory({
  empty = false,
  historyVisible = false,
  onReady,
  onError,
}: StoryRenderControls & { empty?: boolean; historyVisible?: boolean }) {
  const { board: STORY_BOARD, climbs } = useStoryBoardFixture();
  const initialQueue = useMemo(() => climbs.map((climb) => climbToQueueItem(climb)), [climbs]);
  const sheetRef = useRef<BottomSheetModal>(null);
  const managed = useStorySheetPresentation(sheetRef);
  const presented = managed.presented;
  const [artReady, setArtReady] = useState(empty);
  const markArtReady = useCallback(() => setArtReady(true), []);
  const art = useVisibleArtReadiness(assetId, markArtReady);
  useEffect(() => {
    if (presented && artReady) onReady();
  }, [presented, artReady, onReady]);
  const insets = useSafeAreaInsets();
  const [queue, setQueue] = useState(empty ? [] : initialQueue);
  const [current, setCurrent] = useState<ClimbQueueItem | null>(
    empty ? null : initialQueue[Math.min(historyVisible ? 1 : 0, initialQueue.length - 1)],
  );
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(historyVisible);
  const [fullHistory, setFullHistory] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [dragging, setDragging] = useState(false);
  const toggleSelected = useCallback(
    (uuid: string) =>
      setSelected((previous) => {
        const next = new Set(previous);
        if (next.has(uuid)) next.delete(uuid);
        else next.add(uuid);
        return next;
      }),
    [],
  );
  const remove = useCallback(
    (uuid: string) => setQueue((previous) => previous.filter((item) => item.uuid !== uuid)),
    [],
  );
  const reorder = useCallback(
    (_uuid: string, oldIndex: number, newIndex: number) =>
      setQueue((previous) => {
        const next = [...previous];
        const [item] = next.splice(oldIndex, 1);
        next.splice(newIndex, 0, item);
        return next;
      }),
    [],
  );
  return (
    <QueueSheetView
      ref={sheetRef}
      isDragging={dragging}
      onChange={managed.onChange}
      onFullyDismissed={managed.onFullyDismissed}
    >
      <StoryClimbArtObserverProvider onDisplayed={art.onDisplayed} onError={onError}>
        <View style={{ flex: 1 }} onLayout={managed.onLayout}>
          <QueueListBodyView
            header={
              <QueueSheetHeader
                isEditMode={editing}
                showHistory={history}
                selectedCount={selected.size}
                queueCount={Math.max(0, queue.length - (historyVisible ? 2 : 1))}
                viewOnlyMode={queue.length === 0}
                onToggleEditMode={() => setEditing((previous) => !previous)}
                onToggleHistory={() => setHistory((previous) => !previous)}
                onClose={managed.handle.dismiss}
                onClearAll={() => setQueue([])}
              />
            }
            list={
              <QueueListView
                onViewableItemsChanged={art.onViewableItemsChanged}
                queue={queue}
                currentItem={current}
                historyCount={empty || !historyVisible || initialQueue.length < 2 ? 0 : 1}
                board={STORY_BOARD}
                isEditMode={editing}
                showHistory={history}
                showFullHistory={fullHistory}
                selectedItems={selected}
                playlistSuggestionSource={null}
                active
                onToggleSelect={toggleSelected}
                onClimbPress={setCurrent}
                onRemove={remove}
                onShowFullHistory={() => setFullHistory(true)}
                onTickHistory={noop}
                onSuggestionPress={noop}
                reorderQueue={reorder}
                onDraggingChange={setDragging}
                presentation="sheet"
                rowDisplay={DEFAULT_CLIMB_ROW_DISPLAY}
                showAddedBy={false}
                viewerUserId={null}
                boardContinuationClimbs={[]}
                RowComponent={StoryRow}
                ContentComponent={renderStoryClimbContent}
              />
            }
            isEditMode={editing}
            selectedCount={selected.size}
            bottomInset={insets.bottom}
            onRemove={() => {
              setQueue((previous) => previous.filter((item) => !selected.has(item.uuid)));
              setSelected(new Set());
            }}
          />
        </View>
      </StoryClimbArtObserverProvider>
    </QueueSheetView>
  );
}
const stories: StoryModule = {
  title: 'Queue',
  stories: {
    'up-next': {
      name: 'Up next',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <QueueStory {...controls} />,
    },
    historyTick: {
      name: 'History and up next',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <QueueStory {...controls} historyVisible />,
    },
    empty: {
      name: 'Empty queue',
      layout: 'fullscreen',
      readiness: 'explicit',
      render: (controls) => <QueueStory {...controls} empty />,
    },
  },
};
export default stories;
