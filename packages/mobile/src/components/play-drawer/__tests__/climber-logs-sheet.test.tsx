// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { Climb } from '@boardsesh/shared-schema';

const dimensions = vi.hoisted(() => ({ fontScale: 1 }));
vi.mock('react-native', () => ({
  useWindowDimensions: () => ({ fontScale: dimensions.fontScale }),
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
type BareProps = {
  groups: Array<{ userId: string }>;
  wide: boolean;
  underTriedHeading?: boolean;
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
  ClimberLogBareRow: (props: BareProps) =>
    createElement(
      'div',
      {
        'data-testid': 'bare-row',
        'data-wide': String(props.wide),
        'data-expanded': String(props.earlierExpanded),
        'data-under-tried': String(props.underTriedHeading),
      },
      props.groups.map((group) =>
        createElement(
          'div',
          { key: group.userId, 'data-testid': 'bare-cell', 'data-user': group.userId },
          createElement('button', { type: 'button', onClick: () => props.onPressClimber(group.userId) }, 'open'),
        ),
      ),
      props.wide
        ? createElement(
            'button',
            { type: 'button', onClick: () => props.onPressEarlier?.(props.groups[0].userId) },
            'earlier',
          )
        : null,
    ),
  ClimberLogEarlierRow: ({ log }: { log: { uuid: string } }) =>
    createElement('div', { 'data-testid': 'earlier-row' }, log.uuid),
  ClimberLogEarlierFoldRow: ({ angle, count }: { angle: number; count: number }) =>
    createElement('div', { 'data-testid': 'earlier-fold' }, `${count}@${angle}`),
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

/** Every climber on screen, top to bottom: the ones with a row and the bare ones in cells. */
function rowUsers(view: { container: HTMLElement }): string[] {
  return [...view.container.querySelectorAll('[data-user]')].map((node) => node.getAttribute('data-user') ?? '');
}

function kinds(view: { getByTestId: (id: string) => HTMLElement }): Array<string | null> {
  return [...view.getByTestId('sheet-flat-list').querySelectorAll('[data-kind]')].map((node) =>
    node.getAttribute('data-kind'),
  );
}

beforeEach(() => {
  dimensions.fontScale = 1;
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

  it('keeps the other-angles number true to the other chips', () => {
    // Five followed climbers logged it, two at 40°, and both senders sent at 40°.
    setLoaded(
      [
        log({ userId: 'mika', angle: 40, status: 'send', comment: 'drop knee' }),
        log({ userId: 'jonas', angle: 40, status: 'send' }),
        log({ userId: 'priya', angle: 20, status: 'attempt' }),
      ],
      { climberCount: 5, senderCount: 2, byAngle: [{ angle: 40, climberCount: 2, senderCount: 2 }] },
    );
    const view = renderSheet();
    expect(view.container.textContent).toContain('mobile.climberLogs.otherAngles:{"count":3}');

    // Nobody sent it anywhere else, so there is nothing more to offer.
    fireEvent.click(chip(view, 'mobile.climberLogs.filterSendsOnly'));
    expect(view.container.textContent).toContain('mobile.climberLogs.sectionFollowingAtAngle:{"count":2,"angle":40}');
    expect(view.container.textContent).not.toContain('mobile.climberLogs.otherAngles');

    // The server has no count for notes, so that chip drops the notice too.
    fireEvent.click(chip(view, 'mobile.climberLogs.filterSendsOnly'));
    fireEvent.click(chip(view, 'mobile.climberLogs.filterWithNotes'));
    expect(rowUsers(view)).toEqual(['mika']);
    expect(view.container.textContent).not.toContain('mobile.climberLogs.otherAngles');
  });

  it('counts only the senders elsewhere while "Sends only" is on', () => {
    setLoaded(
      [log({ userId: 'mika', angle: 40, status: 'send' }), log({ userId: 'jonas', angle: 45, status: 'send' })],
      {
        climberCount: 5,
        senderCount: 2,
        byAngle: [{ angle: 40, climberCount: 2, senderCount: 1 }],
      },
    );
    const view = renderSheet();

    fireEvent.click(chip(view, 'mobile.climberLogs.filterSendsOnly'));
    fireEvent.click(view.getByText('mobile.climberLogs.otherAngles:{"count":1}'));

    expect(rowUsers(view).toSorted()).toEqual(['jonas', 'mika']);
  });

  it('says the list is cut at the latest 100 logs and hides the earlier-log lines', () => {
    setLoaded(
      [
        log({ userId: 'mika', comment: 'beta' }),
        log({ userId: 'mika' }),
        log({ userId: 'jonas' }),
        log({ userId: 'jonas' }),
      ],
      { climberCount: 40, senderCount: 30, byAngle: [{ angle: 40, climberCount: 40, senderCount: 30 }] },
      true,
    );
    const view = renderSheet();

    expect(view.getByText('mobile.climberLogs.cappedNotice')).toBeTruthy();
    expect(view.getByTestId('climber-row').getAttribute('data-hide-earlier')).toBe('true');
    // A bare climber's earlier logs are not offered either, and the block has no number.
    expect(view.getByTestId('bare-row').getAttribute('data-wide')).toBe('false');
    expect(view.getByText('mobile.climberLogs.bareHeaderSent')).toBeTruthy();
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
    expect(kinds(view)).toEqual(['header', 'group', 'earlier', 'bareHeader', 'bare']);
    const expandedRow = view.getAllByTestId('climber-row').find((node) => node.getAttribute('data-user') === 'mika');
    expect(expandedRow?.getAttribute('data-expanded')).toBe('true');

    fireEvent.click(expandedRow!.querySelectorAll('button')[1]);
    expect(view.queryByTestId('earlier-row')).toBeNull();
  });

  it('gives bare climbers no row: two to a line under their own headings, after the rows', () => {
    setLoaded(
      [
        log({ userId: 'ana' }),
        log({ userId: 'tess', comment: 'heel on' }),
        log({ userId: 'jo' }),
        log({ userId: 'kit' }),
        log({ userId: 'bea', status: 'attempt' }),
      ],
      { climberCount: 5, senderCount: 4, byAngle: [{ angle: 40, climberCount: 5, senderCount: 4 }] },
    );
    const view = renderSheet();

    expect(kinds(view)).toEqual(['header', 'group', 'bareHeader', 'bare', 'bare', 'bareHeader', 'bare']);
    expect(view.getAllByTestId('climber-row').map((node) => node.getAttribute('data-user'))).toEqual(['tess']);
    const bareRows = view.getAllByTestId('bare-row');
    expect(bareRows[0].querySelectorAll('[data-testid="bare-cell"]')).toHaveLength(2);
    expect(view.getByText('mobile.climberLogs.bareHeaderSentCount:{"count":3}')).toBeTruthy();
    expect(view.getByText('mobile.climberLogs.bareHeaderTriedCount:{"count":1}')).toBeTruthy();
    expect(rowUsers(view)).toEqual(['tess', 'ana', 'jo', 'kit', 'bea']);
  });

  it('puts one bare climber on a line once the text size reaches 130%', () => {
    dimensions.fontScale = 1.3;
    setLoaded([log({ userId: 'ana' }), log({ userId: 'jo' })], {
      climberCount: 2,
      senderCount: 2,
      byAngle: [{ angle: 40, climberCount: 2, senderCount: 2 }],
    });
    const view = renderSheet();
    const bareRows = view.getAllByTestId('bare-row');
    expect(bareRows).toHaveLength(2);
    expect(bareRows.every((row) => row.querySelectorAll('[data-testid="bare-cell"]').length === 1)).toBe(true);
  });

  it('has no bare lines with "With notes" on, and no "Tried, no send" with "Sends only" on', () => {
    setLoaded(
      [log({ userId: 'tess', comment: 'heel on' }), log({ userId: 'ana' }), log({ userId: 'bea', status: 'attempt' })],
      { climberCount: 3, senderCount: 2, byAngle: [{ angle: 40, climberCount: 3, senderCount: 2 }] },
    );
    const view = renderSheet();
    expect(view.container.textContent).toContain('mobile.climberLogs.bareHeaderTriedCount');

    fireEvent.click(chip(view, 'mobile.climberLogs.filterSendsOnly'));
    expect(view.container.textContent).not.toContain('mobile.climberLogs.bareHeaderTried');
    expect(rowUsers(view)).toEqual(['tess', 'ana']);

    fireEvent.click(chip(view, 'mobile.climberLogs.filterWithNotes'));
    expect(view.queryByTestId('bare-row')).toBeNull();
    expect(view.container.textContent).not.toContain('mobile.climberLogs.bareHeader');
    expect(rowUsers(view)).toEqual(['tess']);
  });

  it("opens a bare climber's earlier logs from their own line, folding the plain repeats", () => {
    setLoaded(
      [
        log({ userId: 'mj', attemptCount: 1, climbedAt: '2026-03-10T18:00:00' }),
        log({ userId: 'mj', uuid: 'hard', attemptCount: 8, climbedAt: '2026-02-01T18:00:00' }),
        ...Array.from({ length: 3 }, () => log({ userId: 'mj', attemptCount: 1, climbedAt: '2026-01-01T18:00:00' })),
        log({ userId: 'ana' }),
      ],
      { climberCount: 2, senderCount: 2, byAngle: [{ angle: 40, climberCount: 2, senderCount: 2 }] },
    );
    const view = renderSheet();
    expect(view.getAllByTestId('bare-row')[0].getAttribute('data-wide')).toBe('true');
    expect(view.queryByTestId('earlier-row')).toBeNull();

    fireEvent.click(view.getByText('earlier'));

    expect(kinds(view)).toEqual(['header', 'bareHeader', 'bare', 'earlier', 'earlierFold', 'bare']);
    expect(view.getByTestId('earlier-row').textContent).toBe('hard');
    expect(view.getByTestId('earlier-fold').textContent).toBe('3@40');
    expect(view.getAllByTestId('bare-row')[0].getAttribute('data-expanded')).toBe('true');
  });

  it('keeps the Following header over "more at other angles" when the chips leave no rows', () => {
    setLoaded([log({ userId: 'jonas', angle: 45 })], {
      climberCount: 1,
      senderCount: 1,
      byAngle: [{ angle: 45, climberCount: 1, senderCount: 1 }],
    });
    const view = renderSheet();
    fireEvent.click(chip(view, ANGLE_CHIP));

    expect(kinds(view)).toEqual(['header', 'notice']);
    expect(view.container.textContent).toContain('mobile.climberLogs.sectionFollowingAtAngle:{"count":0,"angle":40}');
    expect(view.getByText('mobile.climberLogs.otherAngles:{"count":1}')).toBeTruthy();
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
