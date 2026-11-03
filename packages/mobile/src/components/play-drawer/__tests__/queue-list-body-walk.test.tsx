// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Climb, ClimbQueueItem } from '@boardsesh/queue';

// The queue sheet's Then from rows must walk as the swipe does (Then-signposts,
// 2026-11-02): from the queue's own current climb, past the climbs this wall
// can't draw. QueueList takes both as props; this pins that QueueListBody hands
// it the real ones, the board from `useQueueWalkBoard` and the current climb
// from the queue snapshot the sheet holds.

type Children = { children?: ReactNode };

const kilterWalk = vi.hoisted(() => ({ activeConfig: { boardName: 'kilter', layoutId: 1 } }));
const listProps = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  // The queue Undo reads the screen reader state (its longer timeout).
  AccessibilityInfo: {
    isScreenReaderEnabled: () => Promise.resolve(false),
    addEventListener: () => ({ remove: () => {} }),
  },
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#fff', separator: '#ccc' } }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticWarning: vi.fn() }));
vi.mock('../../../theme/colors', () => ({ brandColors: { error: '#f00' } }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { white: '#fff' } }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 3: 12, 4: 16 } }));
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 0 }));
vi.mock('../../PressableSurface', () => ({ PressableSurface: ({ children }: Children) => children }));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../UndoSnackbar', () => ({ UndoSnackbar: () => null }));
vi.mock('../QueueSheetHeader', () => ({ QueueSheetHeader: () => null }));
vi.mock('../QueueList', () => ({
  QueueList: (props: Record<string, unknown>) => {
    listProps.calls.push(props);
    return null;
  },
}));
vi.mock('../../../providers/queue/use-queue-walk-board', () => ({ useQueueWalkBoard: () => kilterWalk }));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({
    removeQueueItems: vi.fn(),
    clearQueue: vi.fn(),
    reorderQueue: vi.fn(),
    restoreQueueItems: vi.fn(),
    getQueueSnapshot: vi.fn(),
    setPlaylistSuggestionSource: vi.fn(),
  }),
  usePlaylistSuggestionSource: () => null,
  useQueueSessionId: () => ({ sessionId: null, undoScope: 'solo' }),
}));

import { QueueListBody } from '../QueueListBody';

function climb(uuid: string): Climb {
  return { uuid, name: `Climb ${uuid}` } as Climb;
}

afterEach(() => {
  cleanup();
  listProps.calls = [];
});

describe('QueueListBody: the walk behind Then from', () => {
  it('hands the list the walk board and the queue snapshot current climb', () => {
    // Not in the queue yet: a commit before the server's echo. The list still
    // walks from it, as the player does.
    const current: ClimbQueueItem = { uuid: 'pending', climb: climb('cur') };
    const queue: ClimbQueueItem[] = [{ uuid: 'u1', climb: climb('x1') }];
    render(
      createElement(QueueListBody, {
        board: { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1', angle: 40 },
        queue,
        currentClimbQueueItem: current,
        historyCount: null,
        active: true,
        presentation: 'panel',
        onClimbPress: vi.fn(),
        onSuggestionPress: vi.fn(),
        onTickHistory: vi.fn(),
      }),
    );
    const props = listProps.calls.at(-1);
    expect(props?.walkBoard).toBe(kilterWalk);
    expect(props?.currentItem).toBe(current);
    expect(props?.queue).toBe(queue);
  });
});
