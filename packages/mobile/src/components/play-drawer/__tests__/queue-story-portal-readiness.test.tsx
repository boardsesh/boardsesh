// @vitest-environment jsdom
import { createElement, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const portal = vi.hoisted(() => ({
  children: null as unknown,
  listeners: new Set<() => void>(),
  queueState: null as { currentUuid?: string; historyCount: number; showHistory: boolean } | null,
}));
const artContext = await vi.hoisted(async () => {
  const { createContext } = await import('react');
  return createContext<((uuid: string) => void) | null>(null);
});
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('../../../dev/stories/use-story-sheet-presentation', () => ({
  useStorySheetPresentation: () => ({
    presented: true,
    onChange: () => {},
    onFullyDismissed: () => {},
    onLayout: () => {},
    handle: { dismiss: () => {} },
  }),
}));
vi.mock('../../../dev/stories/StoryClimbRow', () => ({
  StoryClimbArtObserverProvider: ({
    onDisplayed,
    children,
  }: {
    onDisplayed: (uuid: string) => void;
    children: ReactNode;
  }) => createElement(artContext.Provider, { value: onDisplayed }, children),
  renderStoryClimbContent: ({ climb }: { climb: { uuid: string } }) => {
    const onDisplayed = useContext(artContext);
    useEffect(() => {
      onDisplayed?.(climb.uuid);
    }, [onDisplayed, climb.uuid]);
    return createElement('div', { 'data-testid': 'loaded-art' }, climb.uuid);
  },
}));
vi.mock('../../../lib/climb-to-queue-item', () => ({
  climbToQueueItem: (climb: { uuid: string }) => ({ uuid: climb.uuid, climb }),
}));
vi.mock('../../QueueItemRowView', () => ({ QueueItemRowView: () => null }));
vi.mock('../QueueSheetHeader', () => ({ QueueSheetHeader: () => null }));
vi.mock('../QueueListBodyView', () => ({
  QueueListBodyView: ({ list }: { list: ReactNode }) => list,
}));
vi.mock('../QueueListView', () => ({
  QueueListView: ({
    queue,
    ContentComponent,
    onViewableItemsChanged,
    currentItem,
    historyCount,
    showHistory,
  }: {
    queue: { climb: { uuid: string } }[];
    currentItem: { climb: { uuid: string } } | null;
    historyCount: number;
    showHistory: boolean;
    ContentComponent: React.ComponentType<{ climb: { uuid: string } }>;
    onViewableItemsChanged: (event: {
      viewableItems: { item: { type: string; item: { climb: { uuid: string } } } }[];
    }) => void;
  }) => {
    portal.queueState = { currentUuid: currentItem?.climb.uuid, historyCount, showHistory };
    useEffect(() => {
      onViewableItemsChanged({ viewableItems: queue.map((item) => ({ item: { type: 'future-item', item } })) });
    }, [queue, onViewableItemsChanged]);
    return createElement(
      'div',
      null,
      queue.map((item) => createElement(ContentComponent, { key: item.climb.uuid, climb: item.climb })),
    );
  },
}));
// Gorhom stores the modal's children and renders them under its root host.
// Providers outside those children do not follow them into that host.
vi.mock('../QueueSheetView', () => ({
  QueueSheetView: ({ children }: { children: ReactNode }) => {
    useEffect(() => {
      portal.children = children;
      for (const listener of portal.listeners) listener();
    }, [children]);
    return null;
  },
}));
import stories from '../QueueSheet.stories';
import { STORY_CLIMBS } from '../../../dev/fixtures/climbs';

const subscribe = (listener: () => void) => {
  portal.listeners.add(listener);
  return () => {
    portal.listeners.delete(listener);
  };
};
const snapshot = () => portal.children as ReactNode;
function DetachedModalHost() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
beforeEach(() => {
  portal.children = null;
  portal.listeners.clear();
});
afterEach(cleanup);

it('waits for visible art inside a modal host outside the story subtree', async () => {
  const onReady = vi.fn();
  const onError = vi.fn();
  const view = render(
    createElement(
      'div',
      null,
      stories.stories['up-next'].render({ onReady, onError }),
      createElement(DetachedModalHost),
    ),
  );
  await waitFor(() => expect(onReady).toHaveBeenCalled());
  expect(view.getAllByTestId('loaded-art')).toHaveLength(STORY_CLIMBS.length);
  expect(portal.queueState).toEqual({ currentUuid: STORY_CLIMBS[0].uuid, historyCount: 0, showHistory: false });
  expect(onError).not.toHaveBeenCalled();
});
