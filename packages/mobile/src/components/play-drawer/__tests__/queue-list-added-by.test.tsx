// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';

// Wiring guard for #4672. `QueueItemRow` renders in THREE places inside
// QueueList — history, current and future — and nothing else in the repo renders
// QueueList unmounted (QueueSheet's freeze test mocks it wholesale), so passing
// the attribution props to only two of the three would ship a green suite and a
// visibly broken feature. This file renders the real QueueList over all three row
// kinds and asserts every captured row got the props.

const session = vi.hoisted(() => ({
  sessionId: null as string | null,
  profile: null as { id: string } | null,
}));

const capturedRows = vi.hoisted(() => ({
  props: [] as Record<string, unknown>[],
}));

type ViewProps = { children?: ReactNode; testID?: string; style?: unknown };

vi.mock('react-native', () => ({
  View: ({ children }: ViewProps) => createElement('div', null, children),
  Pressable: ({ children }: ViewProps) => createElement('div', null, children),
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetFlatList: ({
    data,
    renderItem,
    keyExtractor,
  }: {
    data: unknown[];
    renderItem: (info: { item: unknown; index: number }) => ReactNode;
    keyExtractor: (item: unknown, index: number) => string;
  }) =>
    createElement(
      'div',
      null,
      data.map((item, index) => createElement('div', { key: keyExtractor(item, index) }, renderItem({ item, index }))),
    ),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { separator: '#ccc', secondaryBackground: '#fff' },
    brandColors: { primary: '#6D28D9' },
  }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 10: 40, 16: 64 },
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#888' } }));
vi.mock('../../../lib/graphql/hooks', () => ({ useSearchClimbs: () => ({ data: undefined }) }));
vi.mock('../../sheet-content-inset', () => ({ withSheetBottomInset: (style: unknown) => style }));
vi.mock('../use-queue-drag', () => ({
  useQueueDrag: () => ({
    isDragging: false,
    controls: {
      shared: {},
      onRowHeight: vi.fn(),
      makeHandleGesture: vi.fn(),
    },
  }),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: ViewProps) => createElement('span', null, children) }));
vi.mock('../../ClimbListItemContent', () => ({ ClimbListItemContent: () => createElement('span', null) }));

// Capture every QueueItemRow render's props. Also re-exports the two layout
// constants QueueList imports from the same module for its styles.
vi.mock('../../QueueItemRow', () => ({
  POSITION_SLOT_WIDTH: 28,
  SEPARATOR_INSET: 200,
  QueueItemRow: (props: Record<string, unknown>) => {
    capturedRows.props.push(props);
    return createElement('div');
  },
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: session.sessionId }),
}));

vi.mock('../../../providers/party-profile-provider', () => ({
  usePartyProfile: () => ({ profile: session.profile }),
}));

import { QueueList } from '../QueueList';

const board = { boardName: 'kilter' as const, layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };

function makeItem(uuid: string): ClimbQueueItem {
  return {
    uuid,
    climb: { uuid: `climb-${uuid}`, name: `Climb ${uuid}` },
    addedByUser: { id: 'peer-1', username: 'Mina', avatarUrl: null },
  } as ClimbQueueItem;
}

const queue = [makeItem('a'), makeItem('b'), makeItem('c')];

function renderList() {
  return render(
    <QueueList
      queue={queue}
      currentItemUuid="b"
      board={board}
      isEditMode={false}
      showHistory
      showFullHistory
      selectedItems={new Set<string>()}
      playlistSuggestionSource={null}
      active
      onToggleSelect={vi.fn()}
      onClimbPress={vi.fn()}
      onRemove={vi.fn()}
      onShowFullHistory={vi.fn()}
      onTickHistory={vi.fn()}
      onSuggestionPress={vi.fn()}
      reorderQueue={vi.fn()}
    />,
  );
}

describe('QueueList added-by wiring', () => {
  beforeEach(() => {
    capturedRows.props = [];
    session.sessionId = null;
    session.profile = null;
  });

  it('passes attribution to all three row kinds during a session', () => {
    session.sessionId = 'session-1';
    session.profile = { id: 'me' };
    renderList();

    // History (a), current (b) and future (c) — assert the row kinds too, so a
    // future row-order change can't quietly make this assertion vacuous.
    expect(capturedRows.props).toHaveLength(3);
    expect(capturedRows.props[0].isHistoryItem).toBe(true);
    expect(capturedRows.props[1].isCurrentClimb).toBe(true);
    expect(capturedRows.props[2].isDraggable).toBe(true);

    for (const props of capturedRows.props) {
      expect(props.showAddedBy).toBe(true);
      expect(props.viewerUserId).toBe('me');
    }
  });

  it('switches attribution off outside a session', () => {
    session.sessionId = null;
    session.profile = { id: 'me' };
    renderList();

    expect(capturedRows.props).toHaveLength(3);
    for (const props of capturedRows.props) {
      expect(props.showAddedBy).toBe(false);
    }
  });

  it('still shows peers faces to a viewer with no party profile', () => {
    session.sessionId = 'session-1';
    session.profile = null;
    renderList();

    expect(capturedRows.props).toHaveLength(3);
    for (const props of capturedRows.props) {
      expect(props.showAddedBy).toBe(true);
      expect(props.viewerUserId).toBeNull();
    }
  });
});
