import { upNextStart, type ClimbQueue, type ClimbQueueItem } from '@boardsesh/queue';

// The last 2 climbed. The mobile queue sheet (the only consumer) trialled 5 and
// cut it to 2 in its QA pass so Up next stays on screen at the 70% detent;
// "Show full history" expands the rest. Callers may pass their own limit.
const DEFAULT_HISTORY_DISPLAY_LIMIT = 2;

export type QueueFlatRow =
  | { type: 'history-show-all'; hiddenCount: number }
  | { type: 'history-item'; item: ClimbQueueItem; queueIndex: number }
  | { type: 'history-divider' }
  | { type: 'current-item'; item: ClimbQueueItem; queueIndex: number }
  | { type: 'future-item'; item: ClimbQueueItem; queueIndex: number };

export type QueueListModel = {
  flatRows: QueueFlatRow[];
  currentItemFlatIndex: number;
};

export function buildQueueListModel(
  queue: ClimbQueue,
  currentItemUuid: string | null,
  options: {
    showHistory: boolean;
    showFullHistory: boolean;
    historyDisplayLimit?: number;
    /**
     * The History / Up next line while nothing is current (F3, now-slot mode).
     * Absent or null (legacy): with nothing current the whole queue is Up next.
     */
    historyCount?: number | null;
  },
): QueueListModel {
  const limit = options.historyDisplayLimit ?? DEFAULT_HISTORY_DISPLAY_LIMIT;
  const rows: QueueFlatRow[] = [];
  let currentItemFlatIndex = -1;

  const currentIndex = currentItemUuid ? queue.findIndex((item) => item.uuid === currentItemUuid) : -1;
  const currentItem = currentIndex >= 0 ? queue[currentIndex] : null;
  // History = queue[0, line), Now at the line when a climb is current, then Up
  // next. With nothing current (or an orphan) the line is `historyCount`.
  const firstUpNextIndex = upNextStart(queue, currentItem, options.historyCount);
  const historyEnd = currentIndex >= 0 ? currentIndex : firstUpNextIndex;

  const historyItems = queue.slice(0, historyEnd);
  const futureItems = queue.slice(firstUpNextIndex);

  if (options.showHistory && historyItems.length > 0) {
    const hiddenCount = options.showFullHistory ? 0 : Math.max(0, historyItems.length - limit);
    if (hiddenCount > 0) {
      rows.push({ type: 'history-show-all', hiddenCount });
    }
    const firstRenderedIdx = hiddenCount;
    for (let i = firstRenderedIdx; i < historyItems.length; i++) {
      rows.push({ type: 'history-item', item: historyItems[i], queueIndex: i });
    }
    rows.push({ type: 'history-divider' });
  }

  if (currentItem) {
    currentItemFlatIndex = rows.length;
    rows.push({ type: 'current-item', item: currentItem, queueIndex: currentIndex });
  }

  for (let i = 0; i < futureItems.length; i++) {
    const originalIndex = firstUpNextIndex + i;
    if (i === 0 && !currentItem) {
      currentItemFlatIndex = rows.length;
    }
    rows.push({ type: 'future-item', item: futureItems[i], queueIndex: originalIndex });
  }

  return { flatRows: rows, currentItemFlatIndex };
}
