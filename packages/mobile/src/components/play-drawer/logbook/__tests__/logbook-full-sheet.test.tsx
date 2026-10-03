// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { LogbookEntry } from '@boardsesh/board-react';

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));

// Stands in for the sheet-aware virtualised list. It records what it was handed
// and renders through `renderItem`, so the test proves the rows reach the screen
// by way of the list rather than a mapped ScrollView.
type ListProps = {
  data: Array<{ key: string }>;
  renderItem: (info: { item: { key: string } }) => ReactNode;
  keyExtractor: (item: { key: string }) => string;
};
const list = vi.hoisted(() => ({ renders: [] as Array<{ keys: string[] }> }));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetFlatList: ({ data, renderItem, keyExtractor }: ListProps) => {
    list.renders.push({ keys: data.map(keyExtractor) });
    return createElement(
      'div',
      { 'data-testid': 'sheet-flat-list' },
      data.map((item) => createElement('div', { key: keyExtractor(item) }, renderItem({ item }))),
    );
  },
}));

const sheet = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('../../../ModalSheet', () => ({
  ModalSheet: (props: { children?: ReactNode; header?: ReactNode; visible?: boolean }) => {
    sheet.props = props;
    return createElement('section', { 'data-visible': String(props.visible) }, props.header, props.children);
  },
}));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts?.count === undefined ? key : `${key}:${opts.count}`),
  }),
}));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    colorScheme: 'light',
    brandColors: { primary: '#primary', primaryFill: '#primaryFill' },
    systemColors: {},
  }),
}));
vi.mock('../../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGradeByDifficultyId: () => null }),
}));
vi.mock('../../../../lib/clock', () => ({ nowMs: () => Date.parse('2026-06-22T12:00:00Z') }));

const rows = vi.hoisted(() => ({ uuids: [] as string[] }));
vi.mock('../../LogbookEntryRow', () => ({
  LogbookEntryRow: ({ entry }: { entry: { uuid: string } }) => {
    rows.uuids.push(entry.uuid);
    return createElement('div', { 'data-testid': 'entry-row' });
  },
}));

const logbookState = vi.hoisted(() => ({
  logbook: [] as unknown[],
  fetchedUuids: new Set<string>(['climb-1']) as ReadonlySet<string>,
  error: null,
}));
vi.mock('@boardsesh/board-react', () => ({ useLogbook: () => logbookState }));

import { LogbookFullSheet } from '../LogbookFullSheet';

function makeEntry(overrides: Partial<LogbookEntry>): LogbookEntry {
  return {
    uuid: 'tick-1',
    climb_uuid: 'climb-1',
    angle: 40,
    is_mirror: false,
    tries: 1,
    quality: null,
    difficulty: null,
    comment: '',
    climbed_at: '2026-06-01T12:00:00',
    is_ascent: false,
    status: 'attempt',
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
    ...overrides,
  };
}

function renderSheet(overrides: { visible?: boolean; climbUuid?: string | null; onClose?: () => void } = {}) {
  return render(
    createElement(LogbookFullSheet, {
      visible: overrides.visible ?? true,
      climbUuid: overrides.climbUuid === undefined ? 'climb-1' : overrides.climbUuid,
      boardName: 'kilter',
      layoutId: 1,
      angle: 40,
      onClose: overrides.onClose ?? vi.fn(),
    }),
  );
}

beforeEach(() => {
  list.renders = [];
  rows.uuids = [];
  sheet.props = null;
  logbookState.logbook = [];
});

describe('LogbookFullSheet', () => {
  it('shows every session and every log of a long day, through the virtualised list', () => {
    logbookState.logbook = [
      // Nine days at the board angle: three more than the card shows inline.
      ...Array.from({ length: 9 }, (_, day) =>
        makeEntry({ uuid: `day-${day}`, climbed_at: `2026-06-${String(day + 1).padStart(2, '0')}T12:00:00` }),
      ),
      // One 30-log day at another angle: the card would show four of them.
      ...Array.from({ length: 30 }, (_, index) =>
        makeEntry({
          uuid: `long-${index}`,
          angle: 45,
          climbed_at: `2026-06-15T12:${String(index).padStart(2, '0')}:00`,
        }),
      ),
      makeEntry({ uuid: 'other-climb', climb_uuid: 'climb-2' }),
    ];
    const { container, getByTestId, getAllByTestId } = renderSheet();

    const flatList = getByTestId('sheet-flat-list');
    expect(getAllByTestId('logbook-session-tile')).toHaveLength(10);
    expect(flatList.querySelectorAll('[data-testid="logbook-session-tile"]')).toHaveLength(10);
    expect(rows.uuids).toHaveLength(39);
    expect(rows.uuids).not.toContain('other-climb');
    expect(container.textContent).not.toContain('mobile.logbook.moreLogsThatDay');

    // Board angle heading, its nine days, then the other angle and its day.
    const { keys } = list.renders.at(-1) ?? { keys: [] };
    expect(keys[0]).toBe('angle:40');
    expect(keys[10]).toBe('angle:45');
    expect(keys).toHaveLength(12);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is a tall, solid sheet that reports a pan-down close', () => {
    const onClose = vi.fn();
    renderSheet({ onClose });
    expect(sheet.props).toMatchObject({ visible: true, surface: 'solid', snapPoints: ['90%'], onClose });
  });

  it('closes from the header button', () => {
    const onClose = vi.fn();
    const { getByLabelText } = renderSheet({ onClose });
    fireEvent.click(getByLabelText('mobile.logbook.closeFullLogbook'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps its rows while closed, so they do not vanish mid-dismiss', () => {
    logbookState.logbook = [makeEntry({})];
    renderSheet({ visible: false });
    expect(sheet.props).toMatchObject({ visible: false });
    expect(rows.uuids).toEqual(['tick-1']);
  });

  it('stays closed with no climb', () => {
    renderSheet({ climbUuid: null });
    expect(sheet.props).toMatchObject({ visible: false });
  });
});
