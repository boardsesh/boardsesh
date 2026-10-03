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
// Records which climbs the sheet asks the logbook for, on every render.
const logbookCalls = vi.hoisted(() => ({ climbUuids: [] as string[][] }));
vi.mock('@boardsesh/board-react', () => ({
  useLogbook: (_boardName: string, climbUuids: string[]) => {
    logbookCalls.climbUuids.push(climbUuids);
    return logbookState;
  },
}));

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

type SheetOverrides = {
  visible?: boolean;
  climbUuid?: string | null;
  boardName?: 'kilter' | 'tension';
  onClose?: () => void;
};

function sheetElement(overrides: SheetOverrides = {}) {
  return createElement(LogbookFullSheet, {
    visible: overrides.visible ?? true,
    climbUuid: overrides.climbUuid === undefined ? 'climb-1' : overrides.climbUuid,
    boardName: overrides.boardName ?? 'kilter',
    layoutId: 1,
    angle: 40,
    onClose: overrides.onClose ?? vi.fn(),
  });
}

function renderSheet(overrides: SheetOverrides = {}) {
  return render(sheetElement(overrides));
}

beforeEach(() => {
  list.renders = [];
  rows.uuids = [];
  logbookCalls.climbUuids = [];
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
    expect(getAllByTestId('logbook-session')).toHaveLength(10);
    expect(flatList.querySelectorAll('[data-testid="logbook-session"]')).toHaveLength(10);
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

  it('heads every angle in the sheet, the board angle included, with its story', () => {
    logbookState.logbook = [makeEntry({}), makeEntry({ uuid: 'steeper', angle: 45 })];
    const single = renderSheet();
    const text = single.container.textContent ?? '';
    expect(text).toContain('40° · mobile.logbook.angleBoardIsHere · mobile.logbook.angleLine');
    expect(text).toContain('45° · mobile.logbook.angleLine');
  });

  it('prints a day’s try count only under an angle with more than one day', () => {
    logbookState.logbook = [
      makeEntry({ uuid: 'day-1', tries: 3, climbed_at: '2026-06-01T12:00:00' }),
      makeEntry({ uuid: 'day-2', tries: 2, climbed_at: '2026-06-02T12:00:00' }),
      makeEntry({ uuid: 'steeper', angle: 45, tries: 7 }),
    ];
    const { container } = renderSheet();
    const text = container.textContent ?? '';
    expect(text).toContain('mobile.logbook.tries:3');
    expect(text).toContain('mobile.logbook.tries:2');
    expect(text).not.toContain('mobile.logbook.tries:7');
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

  // PlayDrawer hands the sheet null the moment it closes, including when the
  // displayed climb changed under it.
  it('keeps the rows of the climb it was opened for while it dismisses', () => {
    logbookState.logbook = [makeEntry({}), makeEntry({ uuid: 'next-climb-tick', climb_uuid: 'climb-2' })];
    const { rerender, getAllByTestId } = renderSheet();

    rerender(sheetElement({ visible: false, climbUuid: null }));
    expect(sheet.props).toMatchObject({ visible: false });
    expect(getAllByTestId('entry-row')).toHaveLength(1);
    // Never the next climb's row, on any render.
    expect(new Set(rows.uuids)).toEqual(new Set(['tick-1']));
  });

  it('asks the logbook for no other climb while it sits closed', () => {
    const { rerender } = renderSheet();
    rerender(sheetElement({ visible: false, climbUuid: null }));
    rerender(sheetElement({ visible: false, climbUuid: null }));

    expect(new Set(logbookCalls.climbUuids.flat())).toEqual(new Set(['climb-1']));
  });

  it('drops the held climb when the board changes while closed', () => {
    const { rerender } = renderSheet();
    rerender(sheetElement({ visible: false, climbUuid: null }));
    logbookCalls.climbUuids = [];

    rerender(sheetElement({ visible: false, climbUuid: null, boardName: 'tension' }));
    expect(logbookCalls.climbUuids.flat()).toEqual([]);
  });

  it('switches to the new climb when reopened', () => {
    logbookState.logbook = [makeEntry({}), makeEntry({ uuid: 'next-climb-tick', climb_uuid: 'climb-2' })];
    const { rerender } = renderSheet();
    rerender(sheetElement({ visible: false, climbUuid: null }));
    rows.uuids = [];

    rerender(sheetElement({ climbUuid: 'climb-2' }));
    expect(rows.uuids).toEqual(['next-climb-tick']);
  });

  it('stays closed with no climb', () => {
    renderSheet({ climbUuid: null });
    expect(sheet.props).toMatchObject({ visible: false });
  });
});
