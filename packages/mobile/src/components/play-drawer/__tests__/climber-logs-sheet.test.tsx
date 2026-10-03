// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));

// Stands in for the sheet-aware virtualised list. It renders through
// `renderItem`, so the test proves the rows reach the screen by way of the list
// rather than a mapped ScrollView.
type Item = { key: string; kind: string };
type ListProps = {
  data: Item[];
  renderItem: (info: { item: Item }) => ReactNode;
  keyExtractor: (item: Item) => string;
  ListHeaderComponent?: ReactNode;
  ListEmptyComponent?: ReactNode;
  onEndReached?: unknown;
};
const list = vi.hoisted(() => ({ props: null as ListProps | null }));
vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetFlatList: (props: ListProps) => {
    list.props = props;
    return createElement(
      'div',
      { 'data-testid': 'sheet-flat-list' },
      props.ListHeaderComponent,
      props.data.length === 0 ? props.ListEmptyComponent : null,
      props.data.map((item) =>
        createElement('div', { key: props.keyExtractor(item), 'data-kind': item.kind }, props.renderItem({ item })),
      ),
    );
  },
}));

type SheetProps = { children?: ReactNode; header?: ReactNode; visible?: boolean; onFullyDismissed?: () => void };
const sheet = vi.hoisted(() => ({ props: null as SheetProps | null }));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: (props: SheetProps) => {
    sheet.props = props;
    return createElement('section', { 'data-visible': String(props.visible) }, props.header, props.children);
  },
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean };
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        onClick: onPress,
        'aria-label': accessibilityLabel,
        'aria-pressed': accessibilityState?.selected,
      },
      children,
    ),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primary: '#primary', primaryFill: '#primaryFill' }, systemColors: {} }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ formatGrade: (difficulty: string | null | undefined) => difficulty ?? null }),
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: false, reason: null }),
}));

type RowProps = {
  group: { userId: string; lead: { uuid: string }; earlier: unknown[] };
  hideEarlier?: boolean;
  earlierExpanded?: boolean;
  onPressClimber: (userId: string) => void;
  onPressEarlier?: (userId: string) => void;
};
vi.mock('../ClimberLogRow', () => ({
  ClimberLogRow: (props: RowProps) =>
    createElement(
      'div',
      {
        'data-testid': 'climber-row',
        'data-user': props.group.userId,
        'data-lead': props.group.lead.uuid,
        'data-hide-earlier': String(props.hideEarlier),
        'data-expanded': String(props.earlierExpanded),
      },
      createElement('button', { type: 'button', onClick: () => props.onPressClimber(props.group.userId) }, 'open'),
      createElement('button', { type: 'button', onClick: () => props.onPressEarlier?.(props.group.userId) }, 'earlier'),
    ),
  ClimberLogEarlierRow: ({ log }: { log: { uuid: string } }) =>
    createElement('div', { 'data-testid': 'earlier-row' }, log.uuid),
}));

type QueryState = {
  status: 'pending' | 'error' | 'success';
  fetchStatus: 'fetching' | 'paused' | 'idle';
  isLoading: boolean;
  data: unknown;
};
const logsQuery = vi.hoisted(() => ({
  state: null as unknown as QueryState,
  calls: [] as Array<{ climbUuid: string | null; enabled: boolean | undefined }>,
}));
vi.mock('../../../lib/graphql/hooks/use-following-climb-logs', () => ({
  useFollowingClimbLogs: (_boardName: string, climbUuid: string | null, options?: { enabled?: boolean }) => {
    logsQuery.calls.push({ climbUuid, enabled: options?.enabled });
    return logsQuery.state;
  },
}));

import { ClimberLogsSheet } from '../ClimberLogsSheet';
import type { ClimberLog } from '../climber-logs';

let nextId = 0;
function log(overrides: Partial<ClimberLog> = {}): ClimberLog {
  nextId += 1;
  return {
    uuid: `log-${nextId}`,
    userId: 'mika',
    userDisplayName: 'Mika',
    userAvatarUrl: null,
    climbUuid: 'climb-1',
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 2,
    quality: null,
    effectiveQuality: null,
    difficulty: null,
    comment: '',
    climbedAt: '2026-03-10T18:00:00',
    ...overrides,
  };
}

type Summary = {
  climberCount: number;
  senderCount: number;
  byAngle: Array<{ angle: number; climberCount: number; senderCount: number }>;
};

function setLoaded(items: ClimberLog[], summary: Summary, hasMore = false) {
  logsQuery.state = { status: 'success', fetchStatus: 'idle', isLoading: false, data: { items, hasMore, summary } };
}

const climb = { uuid: 'climb-1', name: 'Slow Orbit', difficulty: 'V3' } as Climb;

function renderSheet(overrides: { visible?: boolean; climb?: Climb | null } = {}) {
  const handlers = { onClose: vi.fn(), onOpenProfile: vi.fn() };
  const element = (props: { visible?: boolean; climb?: Climb | null }) =>
    createElement(ClimberLogsSheet, {
      visible: props.visible ?? true,
      climb: props.climb === undefined ? climb : props.climb,
      boardName: 'kilter',
      angle: 40,
      ...handlers,
    });
  const view = render(element(overrides));
  return {
    ...view,
    ...handlers,
    update: (props: { visible?: boolean; climb?: Climb | null }) => view.rerender(element(props)),
  };
}

function chip(view: { getByText: (text: string) => HTMLElement }, key: string): HTMLElement {
  const button = view.getByText(key).closest('button');
  if (!button) throw new Error(`no chip for ${key}`);
  return button;
}

const ANGLE_CHIP = 'mobile.climberLogs.filterAngleOnly:{"angle":40}';

function rowUsers(view: { queryAllByTestId: (id: string) => HTMLElement[] }): string[] {
  return view.queryAllByTestId('climber-row').map((node) => node.getAttribute('data-user') ?? '');
}

beforeEach(() => {
  list.props = null;
  sheet.props = null;
  logsQuery.calls = [];
  setLoaded([], { climberCount: 0, senderCount: 0, byAngle: [] });
});

describe('ClimberLogsSheet', () => {
  it('lists the rows through the virtualised list, with no paging of its own', () => {
    setLoaded([log({ userId: 'mika' }), log({ userId: 'jonas' })], {
      climberCount: 2,
      senderCount: 2,
      byAngle: [{ angle: 40, climberCount: 2, senderCount: 2 }],
    });
    const view = renderSheet();

    expect(view.getByTestId('sheet-flat-list')).toBeTruthy();
    expect(rowUsers(view)).toHaveLength(2);
    expect(list.props?.onEndReached).toBeUndefined();
    expect(view.container.textContent).toContain('mobile.climberLogs.sheetSubtitle:{"name":"Slow Orbit","grade":"V3"}');
  });

  it('only asks while it is open', () => {
    renderSheet({ visible: false });
    expect(logsQuery.calls.at(-1)).toEqual({ climbUuid: 'climb-1', enabled: false });
    expect(sheet.props?.visible).toBe(false);

    renderSheet({ visible: true });
    expect(logsQuery.calls.at(-1)).toEqual({ climbUuid: 'climb-1', enabled: true });
  });

  it('starts on the board angle when someone followed logged there', () => {
    setLoaded([log({ userId: 'mika', angle: 40 }), log({ userId: 'jonas', angle: 45 })], {
      climberCount: 2,
      senderCount: 2,
      byAngle: [
        { angle: 40, climberCount: 1, senderCount: 1 },
        { angle: 45, climberCount: 1, senderCount: 1 },
      ],
    });
    const view = renderSheet();

    expect(chip(view, ANGLE_CHIP).getAttribute('aria-pressed')).toBe('true');
    expect(rowUsers(view)).toEqual(['mika']);
  });

  it('starts on every angle when nobody followed logged at the board angle', () => {
    setLoaded([log({ userId: 'jonas', angle: 45 })], {
      climberCount: 1,
      senderCount: 1,
      byAngle: [{ angle: 45, climberCount: 1, senderCount: 1 }],
    });
    const view = renderSheet();

    expect(chip(view, ANGLE_CHIP).getAttribute('aria-pressed')).toBe('false');
    expect(rowUsers(view)).toEqual(['jonas']);
  });

  it('reads the section count from the summary, not from the rows it holds', () => {
    setLoaded([log({ userId: 'mika' })], {
      climberCount: 5,
      senderCount: 4,
      byAngle: [{ angle: 40, climberCount: 5, senderCount: 4 }],
    });
    const view = renderSheet();

    expect(rowUsers(view)).toHaveLength(1);
    expect(view.container.textContent).toContain('mobile.climberLogs.sectionFollowingAtAngle:{"count":5,"angle":40}');
  });

  it('offers the climbers at other angles, and one tap shows them', () => {
    setLoaded(
      [log({ userId: 'mika', angle: 40 }), log({ userId: 'jonas', angle: 45 }), log({ userId: 'priya', angle: 20 })],
      {
        climberCount: 5,
        senderCount: 3,
        byAngle: [{ angle: 40, climberCount: 2, senderCount: 1 }],
      },
    );
    const view = renderSheet();

    const notice = view.getByText('mobile.climberLogs.otherAngles:{"count":3}');
    fireEvent.click(notice);

    expect(chip(view, ANGLE_CHIP).getAttribute('aria-pressed')).toBe('false');
    expect(rowUsers(view).toSorted()).toEqual(['jonas', 'mika', 'priya']);
    expect(view.container.textContent).not.toContain('mobile.climberLogs.otherAngles');
    expect(view.container.textContent).toContain('mobile.climberLogs.sectionFollowingCount:{"count":5}');
  });

  it('says the list is cut at the latest 100 logs and hides the earlier-log lines', () => {
    setLoaded(
      [log({ userId: 'mika' }), log({ userId: 'mika' })],
      { climberCount: 40, senderCount: 30, byAngle: [{ angle: 40, climberCount: 40, senderCount: 30 }] },
      true,
    );
    const view = renderSheet();

    expect(view.getByText('mobile.climberLogs.cappedNotice')).toBeTruthy();
    expect(view.getByTestId('climber-row').getAttribute('data-hide-earlier')).toBe('true');
  });

  it('narrows with "With notes" and "Sends only", and drops the count while notes are on', () => {
    setLoaded(
      [
        log({ userId: 'noted-send', status: 'send', comment: 'drop knee' }),
        log({ userId: 'plain-send', status: 'send' }),
        log({ userId: 'noted-try', status: 'attempt', comment: 'so close' }),
      ],
      { climberCount: 3, senderCount: 2, byAngle: [{ angle: 40, climberCount: 3, senderCount: 2 }] },
    );
    const view = renderSheet();

    fireEvent.click(chip(view, 'mobile.climberLogs.filterSendsOnly'));
    expect(rowUsers(view).toSorted()).toEqual(['noted-send', 'plain-send']);
    expect(view.container.textContent).toContain('mobile.climberLogs.sectionFollowingAtAngle:{"count":2,"angle":40}');

    fireEvent.click(chip(view, 'mobile.climberLogs.filterWithNotes'));
    expect(rowUsers(view)).toEqual(['noted-send']);
    // No server number exists for "with notes", so the header carries none.
    expect(view.container.textContent).toContain('mobile.climberLogs.sectionFollowing');
    expect(view.container.textContent).not.toContain('mobile.climberLogs.sectionFollowingAtAngle');
    expect(view.container.textContent).not.toContain('mobile.climberLogs.sectionFollowingCount');
  });

  it('says so when the chips leave nothing', () => {
    setLoaded([log({ status: 'attempt' })], {
      climberCount: 1,
      senderCount: 0,
      byAngle: [{ angle: 40, climberCount: 1, senderCount: 0 }],
    });
    const view = renderSheet();

    fireEvent.click(chip(view, 'mobile.climberLogs.filterSendsOnly'));
    expect(rowUsers(view)).toEqual([]);
    expect(view.getByText('mobile.climberLogs.filterEmpty')).toBeTruthy();
  });

  it("opens a climber's other logs in place, and closes them again", () => {
    setLoaded(
      [
        log({ userId: 'mika', comment: 'beta', uuid: 'lead' }),
        log({ userId: 'mika', uuid: 'older', status: 'attempt' }),
        log({ userId: 'jonas' }),
      ],
      { climberCount: 2, senderCount: 2, byAngle: [{ angle: 40, climberCount: 2, senderCount: 2 }] },
    );
    const view = renderSheet();
    expect(view.queryByTestId('earlier-row')).toBeNull();

    const mikaRow = view.getAllByTestId('climber-row').find((node) => node.getAttribute('data-user') === 'mika');
    fireEvent.click(mikaRow!.querySelectorAll('button')[1]);

    expect(view.getByTestId('earlier-row').textContent).toBe('older');
    const kinds = [...view.getByTestId('sheet-flat-list').querySelectorAll('[data-kind]')].map((node) =>
      node.getAttribute('data-kind'),
    );
    expect(kinds).toEqual(['header', 'group', 'earlier', 'group']);
    const expandedRow = view.getAllByTestId('climber-row').find((node) => node.getAttribute('data-user') === 'mika');
    expect(expandedRow?.getAttribute('data-expanded')).toBe('true');

    fireEvent.click(expandedRow!.querySelectorAll('button')[1]);
    expect(view.queryByTestId('earlier-row')).toBeNull();
  });

  it('closes first on a row tap and opens the profile only once the sheet is gone', () => {
    setLoaded([log({ userId: 'mika' })], {
      climberCount: 1,
      senderCount: 1,
      byAngle: [{ angle: 40, climberCount: 1, senderCount: 1 }],
    });
    const view = renderSheet();

    fireEvent.click(view.getByText('open'));
    expect(view.onClose).toHaveBeenCalledTimes(1);
    expect(view.onOpenProfile).not.toHaveBeenCalled();

    sheet.props?.onFullyDismissed?.();
    expect(view.onOpenProfile).toHaveBeenCalledTimes(1);
    expect(view.onOpenProfile).toHaveBeenCalledWith('mika');

    // A later plain dismiss (swipe down) opens nothing.
    sheet.props?.onFullyDismissed?.();
    expect(view.onOpenProfile).toHaveBeenCalledTimes(1);
  });

  it('resets the chips and the open rows on a new climb', () => {
    setLoaded([log({ userId: 'mika', comment: 'beta' }), log({ userId: 'mika', uuid: 'older' })], {
      climberCount: 1,
      senderCount: 1,
      byAngle: [{ angle: 40, climberCount: 1, senderCount: 1 }],
    });
    const view = renderSheet();
    fireEvent.click(chip(view, 'mobile.climberLogs.filterSendsOnly'));
    fireEvent.click(view.getByText('earlier'));
    expect(chip(view, 'mobile.climberLogs.filterSendsOnly').getAttribute('aria-pressed')).toBe('true');
    expect(view.queryByTestId('earlier-row')).not.toBeNull();

    view.update({ climb: { ...climb, uuid: 'climb-2' } as Climb });

    expect(chip(view, 'mobile.climberLogs.filterSendsOnly').getAttribute('aria-pressed')).toBe('false');
    expect(view.queryByTestId('earlier-row')).toBeNull();
  });

  it('says why there is nothing when the request failed', () => {
    logsQuery.state = { status: 'error', fetchStatus: 'idle', isLoading: false, data: undefined };
    const view = renderSheet();
    expect(view.getByText('mobile.offlineState.errorBody')).toBeTruthy();
    expect(rowUsers(view)).toEqual([]);
  });

  it('stays closed without a climb', () => {
    renderSheet({ climb: null });
    expect(sheet.props?.visible).toBe(false);
    expect(logsQuery.calls.at(-1)?.climbUuid).toBeNull();
  });
});
