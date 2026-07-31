// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, within } from '@testing-library/react';
import type { Climb } from '@boardsesh/shared-schema';

type TestEntry = {
  climb_uuid: string;
  angle: number;
  is_mirror: boolean;
  status: 'flash' | 'send' | 'attempt';
  is_ascent: boolean;
  tries: number;
};

const logbookState = vi.hoisted(() => ({
  rootBoardName: 'tension' as string | null,
  rootIndex: new Map<string, TestEntry[]>(),
  accumulatedByBoard: new Map<string, TestEntry[]>(),
  useLogbook: vi.fn(),
  rootFetchedUuids: new Set<string>(),
  rootGetLogbook: vi.fn(),
  rootNetworkFetch: vi.fn(),
}));

vi.mock('@boardsesh/board-react', () => ({
  logbookClimbAngleKey: (climbUuid: string, angle: number) => `${climbUuid}:${angle}`,
  useOptionalBoardActions: () =>
    logbookState.rootBoardName
      ? { boardName: logbookState.rootBoardName, getLogbook: logbookState.rootGetLogbook }
      : null,
  useOptionalBoardLogbook: () => ({ logbookByClimbAngle: logbookState.rootIndex }),
  useLogbook: (boardName: string, climbUuids: string[]) => {
    logbookState.useLogbook(boardName, climbUuids);
    return { logbook: logbookState.accumulatedByBoard.get(boardName) ?? [] };
  },
}));

vi.mock('react-native', () => ({
  View: ({
    children,
    accessibilityLabel,
    accessibilityRole,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) => createElement('div', { 'aria-label': accessibilityLabel, role: accessibilityRole }, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: () => '#abcdef',
  DEFAULT_GRADE_COLOR: '#000000',
}));
vi.mock('../../../lib/format-climb-stats', () => ({ formatSends: () => '', formatQuality: (value: string) => value }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#8E8E93' } }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../MarqueeText', () => ({
  MarqueeText: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../DrawerHeader', () => ({
  DrawerHeader: ({ center }: { center?: ReactNode }) => createElement('div', null, center),
}));
vi.mock('../../ClimbAttributeIcons', () => ({ ClimbAttributeIcons: () => null }));
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));
vi.mock('../SwipeableHeader', () => ({
  SwipeableHeader: ({ current, peek }: { current: ReactNode; peek: ReactNode }) =>
    createElement(
      'div',
      null,
      createElement('div', { 'data-testid': 'current-header' }, current),
      createElement('div', { 'data-testid': 'peek-header' }, peek),
    ),
}));

import { PlayDrawerSwipeableHeader } from '../PlayDrawerSwipeableHeader';

function climb(uuid: string): Climb {
  return {
    uuid,
    name: uuid,
    frames: 'p1r12',
    difficulty: 'V4',
    quality_average: '0',
    ascensionist_count: 0,
    setter_username: '',
    benchmark_difficulty: null,
  } as unknown as Climb;
}

function entry(climbUuid: string, status: TestEntry['status'], angle = 40, isMirror = false): TestEntry {
  return {
    climb_uuid: climbUuid,
    angle,
    is_mirror: isMirror,
    status,
    is_ascent: status !== 'attempt',
    tries: status === 'flash' ? 1 : 2,
  };
}

function indexEntries(entries: TestEntry[]): Map<string, TestEntry[]> {
  const index = new Map<string, TestEntry[]>();
  for (const tick of entries) {
    const key = `${tick.climb_uuid}:${tick.angle}`;
    const bucket = index.get(key);
    if (bucket) bucket.push(tick);
    else index.set(key, [tick]);
  }
  return index;
}

const currentClimb = climb('current');
const peekClimb = climb('peek');
const thirdClimb = climb('third');
const baseProps = {
  boardName: 'tension' as const,
  angle: 40,
  swipeTranslateX: { value: 0 } as never,
  viewportWidth: 390,
  currentClimb,
  currentGrade: null,
  onLongPressCurrentName: vi.fn(),
  peekClimb,
  peekGrade: null,
};

function iconWithin(container: HTMLElement, testId: string): string | null {
  return within(container).getByTestId(testId).querySelector('[data-icon]')?.getAttribute('data-icon') ?? null;
}

describe('PlayDrawerSwipeableHeader logbook I/O', () => {
  beforeEach(() => {
    logbookState.rootBoardName = 'tension';
    logbookState.rootIndex = new Map();
    logbookState.accumulatedByBoard.clear();
    logbookState.useLogbook.mockClear();
    logbookState.rootFetchedUuids.clear();
    logbookState.rootGetLogbook.mockReset();
    logbookState.rootNetworkFetch.mockClear();
    logbookState.rootGetLogbook.mockImplementation(async (climbUuids: string[]) => {
      const missingClimbUuids = climbUuids.filter((climbUuid) => !logbookState.rootFetchedUuids.has(climbUuid));
      if (missingClimbUuids.length > 0) logbookState.rootNetworkFetch(missingClimbUuids);
    });
  });

  it('reuses the matching root index and its fetched tracking for each incoming peek', async () => {
    logbookState.rootIndex = indexEntries([
      entry('current', 'send'),
      // Browse semantics intentionally combine orientations: the mirror flash
      // wins even when the drawer art is currently unmirrored.
      entry('current', 'flash', 40, true),
      entry('current', 'attempt', 30),
      entry('peek', 'attempt'),
      entry('peek', 'send'),
      entry('third', 'flash'),
    ]);
    // The root fetched this in an earlier visible-climbs batch. Calling its
    // stable getLogbook seam must reuse that tracker instead of issuing a new
    // independent query for the same peek.
    logbookState.rootFetchedUuids.add('peek');
    const { container, rerender } = render(createElement(PlayDrawerSwipeableHeader, baseProps));

    await vi.waitFor(() => expect(logbookState.rootGetLogbook).toHaveBeenCalledWith(['peek']));
    expect(logbookState.rootNetworkFetch).not.toHaveBeenCalled();
    expect(logbookState.useLogbook).not.toHaveBeenCalled();
    expect(iconWithin(container, 'current-header')).toBe('flash');
    expect(iconWithin(container, 'peek-header')).toBe('tick.outline');

    rerender(createElement(PlayDrawerSwipeableHeader, { ...baseProps, angle: 30 }));
    expect(iconWithin(container, 'current-header')).toBe('ascent.attempt');

    rerender(
      createElement(PlayDrawerSwipeableHeader, {
        ...baseProps,
        currentClimb: peekClimb,
        peekClimb: thirdClimb,
      }),
    );
    await vi.waitFor(() => expect(logbookState.rootGetLogbook).toHaveBeenLastCalledWith(['third']));
    expect(logbookState.rootGetLogbook.mock.calls.some(([climbUuids]) => climbUuids.includes('current'))).toBe(false);
    expect(iconWithin(container, 'peek-header')).toBe('flash');
  });

  it('reads a foreign board accumulated cache while requesting only its peek', () => {
    logbookState.rootBoardName = 'kilter';
    logbookState.rootIndex = indexEntries([entry('current', 'attempt')]);
    // Models the board-keyed accumulated cache after DeferredSections fetched
    // current and this header's non-overlapping query fetched peek.
    logbookState.accumulatedByBoard.set('tension', [
      entry('current', 'send'),
      entry('current', 'flash', 40, true),
      entry('current', 'attempt', 30),
      entry('peek', 'send'),
    ]);

    const { container } = render(createElement(PlayDrawerSwipeableHeader, baseProps));

    expect(logbookState.useLogbook).toHaveBeenCalledWith('tension', ['peek']);
    expect(logbookState.useLogbook.mock.calls.some(([, climbUuids]) => climbUuids.includes('current'))).toBe(false);
    expect(iconWithin(container, 'current-header')).toBe('flash');
    expect(iconWithin(container, 'peek-header')).toBe('tick.outline');
  });
});
