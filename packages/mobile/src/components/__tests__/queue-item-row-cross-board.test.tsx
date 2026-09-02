// @vitest-environment jsdom
// #5099 — a queue can legitimately hold climbs from more than one board:
// `decideAdd`'s "add anyway", a party peer on another wall, or a board switch
// that leaves the whole queue behind. Each row's thumbnail has to be drawn on
// the board its own climb belongs to; the queue's board is only the fallback.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, useRef, type ReactNode } from 'react';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { QueueItemRowBoard } from '../QueueItemRow';

type BoardProps = { boardName?: string; layoutId?: number; sizeId?: number; setIds?: string; angle?: number };
const recorded = vi.hoisted(() => ({ rows: [] as BoardProps[] }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  useAnimatedStyle: (fn: () => unknown) => fn(),
  useSharedValue: (initial: unknown) => {
    const ref = useRef({ value: initial });
    return ref.current;
  },
  withSpring: (value: unknown) => value,
  withTiming: (value: unknown) => value,
  runOnJS: (fn: unknown) => fn,
}));
vi.mock('react-native-gesture-handler', () => {
  const proxy: Record<string, unknown> = new Proxy({}, { get: () => () => proxy }) as unknown as Record<
    string,
    unknown
  >;
  return {
    GestureDetector: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    Gesture: { Pan: () => proxy, Tap: () => proxy, LongPress: () => proxy, Exclusive: () => ({}) },
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#fff', separator: '#ccc' },
    brandColors: { primary: '#6D28D9', success: '#0a0', error: '#a00' },
  }),
}));
vi.mock('../../lib/haptics', () => ({ hapticSelection: vi.fn(), hapticMedium: vi.fn() }));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../Icon', () => ({ Icon: () => createElement('span', { 'data-icon': 'true' }) }));
vi.mock('../ClimbListItemContent', () => ({
  ClimbListItemContent: (props: BoardProps) => {
    recorded.rows.push(props);
    return createElement('span');
  },
}));
vi.mock('../ClimbListThumbnail', () => ({ THUMBNAIL_WIDTH: 96 }));
vi.mock('../board-presence/BoardDriverAvatar', () => ({ BoardDriverAvatar: () => createElement('span') }));
vi.mock('../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12 } }));
vi.mock('../../theme/animations', () => ({ springs: { interactive: {} } }));
vi.mock('../play-drawer/queue-drag-math', () => ({ rowReorderShift: () => 0 }));

const { QueueItemRow } = await import('../QueueItemRow');

// The queue is bound to the Kilter Original 12x12.
const queueBoard: QueueItemRowBoard = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };

function makeItem(uuid: string, climb: Record<string, unknown>): ClimbQueueItem {
  return { uuid, climb: { uuid: `climb-${uuid}`, name: uuid, frames: 'p1145r15', ...climb } } as ClimbQueueItem;
}

function renderRow(item: ClimbQueueItem) {
  return render(
    createElement(QueueItemRow, {
      item,
      position: 1,
      board: queueBoard,
      isCurrentClimb: false,
      onPress: vi.fn(),
      onRemove: vi.fn(),
    }),
  );
}

beforeEach(() => {
  recorded.rows = [];
  vi.clearAllMocks();
});

describe('QueueItemRow board resolution (#5099)', () => {
  it('draws a Homewall row on the Homewall while the queue sits on the 12x12', () => {
    renderRow(makeItem('homewall', { boardType: 'kilter', layoutId: 8, angle: 30 }));

    const row = recorded.rows.at(-1);
    expect(row?.layoutId).toBe(8);
    expect(row?.sizeId).not.toBe(queueBoard.sizeId);
    // The angle its grade was baked at, not the wall the queue is bound to.
    expect(row?.angle).toBe(30);
  });

  it('leaves a row from the queue board on the queue board', () => {
    renderRow(makeItem('twelve', { boardType: 'kilter', layoutId: 1, angle: 40 }));

    expect(recorded.rows.at(-1)).toMatchObject({
      boardName: queueBoard.boardName,
      layoutId: queueBoard.layoutId,
      sizeId: queueBoard.sizeId,
      setIds: queueBoard.setIds,
      angle: queueBoard.angle,
    });
  });

  it('falls back to the queue board for a row that carries no board metadata', () => {
    // Older queue items and party-synced climbs from before the metadata
    // round-trip. These render fine today and must keep rendering.
    renderRow(makeItem('legacy', {}));

    expect(recorded.rows.at(-1)).toMatchObject({
      boardName: queueBoard.boardName,
      layoutId: queueBoard.layoutId,
      sizeId: queueBoard.sizeId,
    });
  });
});
