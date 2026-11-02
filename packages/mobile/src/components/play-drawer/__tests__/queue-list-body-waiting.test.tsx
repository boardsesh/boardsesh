// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { resetLastPickForTests, setLastPick } from '../../../lib/last-pick-store';

// The queue sheet's count says "· waiting" while the player (or the MiniPlayer's
// last pick) shows a climb whose swipes never reach Up next (Then-signposts,
// 2026-11-02). QueueListBody reads the shown climb from the last-pick store and
// asks the walk; these pin that wiring with the real store and the real walk.

type Children = { children?: ReactNode };

const live = vi.hoisted(() => ({ playlistSource: null as PlaylistSuggestionSource | null }));
const renders = vi.hoisted(() => ({ header: 0 }));
// One object, as the real hook's memo hands out.
const boardBlindWalk = vi.hoisted(() => ({}));

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
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
vi.mock('../QueueSheetHeader', () => ({
  QueueSheetHeader: ({ queueCount, upNextWaiting }: { queueCount: number; upNextWaiting?: boolean }) => {
    renders.header += 1;
    return createElement('div', {
      'data-testid': 'header',
      'data-count': String(queueCount),
      'data-waiting': String(Boolean(upNextWaiting)),
    });
  },
}));
vi.mock('../QueueList', () => ({ QueueList: () => null }));
vi.mock('../../../providers/queue/use-queue-walk-board', () => ({ useQueueWalkBoard: () => boardBlindWalk }));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueActions: () => ({
    removeQueueItems: vi.fn(),
    clearQueue: vi.fn(),
    reorderQueue: vi.fn(),
    restoreQueueItems: vi.fn(),
    getQueueSnapshot: vi.fn(),
    setPlaylistSuggestionSource: vi.fn(),
  }),
  usePlaylistSuggestionSource: () => live.playlistSource,
  useQueueSessionId: () => ({ sessionId: null, undoScope: 'solo' }),
}));

import { QueueListBody } from '../QueueListBody';

function climb(uuid: string): Climb {
  return { uuid, name: `Climb ${uuid}`, frames: 'p1r12', angle: 40 } as Climb;
}

const current: ClimbQueueItem = { uuid: 'e-cur', climb: climb('cur') };
const upNext: ClimbQueueItem[] = [
  { uuid: 'u1', climb: climb('x1') },
  { uuid: 'u2', climb: climb('x2') },
];
const searchResults: PlaylistSuggestionSource = {
  playlistUuid: 'search',
  activatedClimbUuid: 'r1',
  boardKey: 'kilter:1:10:1',
  climbs: [climb('r1'), climb('r2')],
  label: 'Search results',
};

function pick(item: ClimbQueueItem, suggestionSource: PlaylistSuggestionSource | null, currentAtPick = 'e-cur') {
  setLastPick({
    item,
    suggestionSource,
    commitOptions: undefined,
    mirrored: false,
    currentAtPick,
    wallAtPick: null,
    pickedAt: 0,
  });
}

function renderBody(queue: ClimbQueueItem[], active = true) {
  return render(
    createElement(QueueListBody, {
      board: { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1', angle: 40 },
      queue,
      currentClimbQueueItem: current,
      historyCount: null,
      active,
      presentation: 'panel',
      onClimbPress: vi.fn(),
      onSuggestionPress: vi.fn(),
      onTickHistory: vi.fn(),
    }),
  );
}

const waiting = (container: HTMLElement) =>
  container.querySelector('[data-testid="header"]')?.getAttribute('data-waiting');

beforeEach(() => {
  resetLastPickForTests();
  renders.header = 0;
});

afterEach(() => {
  cleanup();
  resetLastPickForTests();
});

describe('QueueListBody: Up next waiting', () => {
  it('waits while the player shows a preview walking its own list', () => {
    pick({ uuid: 'fresh-r1', climb: climb('r1'), suggested: true }, searchResults);
    const { container } = renderBody([current, ...upNext]);
    expect(waiting(container)).toBe('true');
  });

  it('does not wait with nothing but the climb up shown', () => {
    const { container } = renderBody([current, ...upNext]);
    expect(waiting(container)).toBe('false');
  });

  it('does not wait on a preview of an Up next slot', () => {
    pick(upNext[1], null);
    const { container } = renderBody([current, ...upNext]);
    expect(waiting(container)).toBe('false');
  });

  it('does not wait with nothing up next', () => {
    pick({ uuid: 'fresh-r1', climb: climb('r1'), suggested: true }, searchResults);
    const { container } = renderBody([current]);
    expect(waiting(container)).toBe('false');
  });

  it('ignores a pick made under another current climb, which the bar no longer shows', () => {
    pick({ uuid: 'fresh-r1', climb: climb('r1'), suggested: true }, searchResults, 'e-older');
    const { container } = renderBody([current, ...upNext]);
    expect(waiting(container)).toBe('false');
  });

  it('follows a new pick while the list is on screen', () => {
    const { container } = renderBody([current, ...upNext]);
    expect(waiting(container)).toBe('false');
    act(() => pick({ uuid: 'fresh-r1', climb: climb('r1'), suggested: true }, searchResults));
    expect(waiting(container)).toBe('true');
  });

  it('neither says it nor re-renders for picks while the sheet is hidden', () => {
    const { container } = renderBody([current, ...upNext], false);
    const rendersWhileHidden = renders.header;
    act(() => pick({ uuid: 'fresh-r1', climb: climb('r1'), suggested: true }, searchResults));
    expect(renders.header).toBe(rendersWhileHidden);
    expect(waiting(container)).toBe('false');
  });
});
