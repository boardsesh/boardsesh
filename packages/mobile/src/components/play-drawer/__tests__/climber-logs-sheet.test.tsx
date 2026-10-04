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
  ListFooterComponent?: ReactNode;
  onEndReached?: () => void;
  onEndReachedThreshold?: number;
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
      createElement('footer', { 'data-testid': 'list-footer' }, props.ListFooterComponent),
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
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress }, title),
}));
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
const connectivity = vi.hoisted(() => ({
  snapshot: { effectiveOffline: false, reason: null as 'device_offline' | null },
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({ useConnectivity: () => connectivity.snapshot }));
vi.mock('../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: 'viewer', isLoading: false }),
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
        'data-can-expand': String(props.onPressEarlier !== undefined),
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

// Everyone else's logs: the paged query, stood in. `flattenClimbLogPages` is
// the real one (its module only reaches for the network inside the hooks).
type EveryoneArgs = {
  boardName: string;
  climbUuid: string | null;
  angle?: number;
  withNotes: boolean;
  sendsOnly: boolean;
  excludeFollowed: boolean;
  enabled: boolean;
};
type EveryoneState = {
  data: { pages: Array<{ items: unknown[]; cursor: string | null; hasMore: boolean }> } | undefined;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  fetchNextPage: () => Promise<unknown>;
  refetch: () => Promise<unknown>;
};
const everyoneQuery = vi.hoisted(() => ({
  state: null as unknown as EveryoneState,
  calls: [] as EveryoneArgs[],
}));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: vi.fn() }) }));
vi.mock('../../../lib/graphql/hooks/use-climb-logs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/graphql/hooks/use-climb-logs')>()),
  useClimbLogs: (args: EveryoneArgs) => {
    everyoneQuery.calls.push(args);
    return everyoneQuery.state;
  },
}));

// The phone's own list of who the viewer follows.
const followedAuthors = vi.hoisted(() => ({ userIds: null as string[] | null }));
vi.mock('../../../lib/graphql/hooks/use-followed-authors', () => ({
  useFollowedAuthorsSnapshot: () => ({
    data: followedAuthors.userIds
      ? { setterUsernames: [], users: followedAuthors.userIds.map((userId) => ({ userId, boardAccounts: [] })) }
      : undefined,
  }),
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

/** Everyone's logs as loaded pages. The last page says whether more exist. */
function setEveryone(pages: ClimberLog[][], overrides: Partial<EveryoneState> = {}) {
  everyoneQuery.state = {
    data: { pages: pages.map((items) => ({ items, cursor: null, hasMore: false })) },
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    isLoading: false,
    isError: false,
    isSuccess: true,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
    ...overrides,
  };
}

const ONE_FOLLOWED = {
  climberCount: 1,
  senderCount: 1,
  byAngle: [{ angle: 40, climberCount: 1, senderCount: 1 }],
};
const NOBODY_FOLLOWED = { climberCount: 0, senderCount: 0, byAngle: [] };

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
  followedAuthors.userIds = null;
  dimensions.fontScale = 1;
  list.props = null;
  sheet.props = null;
  logsQuery.calls = [];
  everyoneQuery.calls = [];
  connectivity.snapshot = { effectiveOffline: false, reason: null };
  setLoaded([], { climberCount: 0, senderCount: 0, byAngle: [] });
  setEveryone([]);
});

describe('ClimberLogsSheet', () => {
  it('lists the rows through the virtualised list', () => {
    setLoaded([log({ userId: 'mika' }), log({ userId: 'jonas' })], {
      climberCount: 2,
      senderCount: 2,
      byAngle: [{ angle: 40, climberCount: 2, senderCount: 2 }],
    });
    const view = renderSheet();

    expect(view.getByTestId('sheet-flat-list')).toBeTruthy();
    expect(rowUsers(view)).toHaveLength(2);
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

describe('ClimberLogsSheet, everyone else', () => {
  function sectionKinds(view: { getByTestId: (id: string) => HTMLElement }): string[] {
    return [...view.getByTestId('sheet-flat-list').querySelectorAll('[data-kind]')].map(
      (node) => node.getAttribute('data-kind') ?? '',
    );
  }

  it('lists everyone else under the people the viewer follows', () => {
    setLoaded([log({ userId: 'mika', comment: 'beta' })], ONE_FOLLOWED);
    setEveryone([[log({ userId: 'dave', comment: 'beta' }), log({ userId: 'lena', comment: 'beta' })]]);
    const view = renderSheet();

    expect(sectionKinds(view)).toEqual(['header', 'group', 'header', 'group', 'group']);
    // Server order, newest first. No re-rank, or the next page would not land under this one.
    expect(rowUsers(view)).toEqual(['mika', 'dave', 'lena']);
    expect(view.container.textContent).toContain('mobile.climberLogs.everyone.sortHint');
  });

  it('pairs bare strangers that sit next to each other, in server order and with no heading of their own', () => {
    setLoaded([log({ userId: 'mika', comment: 'beta' })], ONE_FOLLOWED);
    setEveryone([
      [
        log({ userId: 'rat', status: 'attempt', comment: 'no swing' }),
        log({ userId: 'dee' }),
        log({ userId: 'pilot' }),
        log({ userId: 'quin', status: 'attempt' }),
      ],
    ]);
    const view = renderSheet();

    expect(sectionKinds(view)).toEqual(['header', 'group', 'header', 'group', 'bare', 'bare']);
    expect(rowUsers(view)).toEqual(['mika', 'rat', 'dee', 'pilot', 'quin']);
    expect(view.container.textContent).not.toContain('mobile.climberLogs.bareHeader');
    // No "Tried, no send" heading above an Everyone cell, so it says the whole result.
    expect(view.getAllByTestId('bare-row').every((row) => row.getAttribute('data-under-tried') === 'false')).toBe(true);
  });

  const CHIPS = ['mobile.climberLogs.filterWithNotes', 'mobile.climberLogs.filterSendsOnly'];
  const COMBINATIONS = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => ({
    angleOff: (mask & 1) === 1,
    chips: CHIPS.filter((_, index) => (mask & (2 << index)) !== 0),
  }));

  it.each(COMBINATIONS)(
    'always lists Following before Everyone, and nobody twice (angle off: $angleOff, chips: $chips)',
    ({ angleOff, chips }) => {
      setLoaded(
        [
          log({ userId: 'mika', status: 'send', comment: 'drop knee' }),
          log({ userId: 'jonas', status: 'send' }),
          log({ userId: 'priya', status: 'attempt', angle: 45 }),
        ],
        {
          climberCount: 3,
          senderCount: 2,
          byAngle: [
            { angle: 40, climberCount: 2, senderCount: 2 },
            { angle: 45, climberCount: 1, senderCount: 0 },
          ],
        },
      );
      // The server sends back the viewer and three followed climbers by mistake.
      setEveryone([
        [
          log({ userId: 'dave', status: 'send', comment: 'soft' }),
          log({ userId: 'mika', status: 'send', comment: 'again' }),
          log({ userId: 'viewer', status: 'send', comment: 'mine' }),
          log({ userId: 'jonas', status: 'send' }),
          log({ userId: 'priya', status: 'send', comment: 'finally' }),
          log({ userId: 'lena', status: 'send' }),
        ],
      ]);
      const view = renderSheet();
      if (angleOff) fireEvent.click(chip(view, ANGLE_CHIP));
      for (const key of chips) fireEvent.click(chip(view, key));

      const nodes = [...view.getByTestId('sheet-flat-list').querySelectorAll('[data-kind]')];
      const everyoneAt = nodes.findIndex((node) => (node.textContent ?? '').includes('mobile.climberLogs.everyone.'));
      const followingAt = nodes.findIndex((node) =>
        (node.textContent ?? '').includes('mobile.climberLogs.sectionFollowing'),
      );
      expect(followingAt).toBe(0);
      expect(everyoneAt).toBeGreaterThan(followingAt);

      const usersIn = (slice: Element[]) =>
        slice.flatMap((node) =>
          [...node.querySelectorAll('[data-user]')].map((user) => user.getAttribute('data-user')),
        );
      const followed = usersIn(nodes.slice(0, everyoneAt));
      const strangers = usersIn(nodes.slice(everyoneAt));
      expect(followed).toContain('mika');
      expect(followed.every((userId) => ['mika', 'jonas', 'priya'].includes(userId ?? ''))).toBe(true);
      // Followed climbers the chips hide are still followed: they never fall into Everyone.
      expect(strangers).toEqual(['dave', 'lena']);
    },
  );

  describe('when the Following list was cut at 100 logs', () => {
    const CAPPED = {
      climberCount: 40,
      senderCount: 30,
      byAngle: [{ angle: 40, climberCount: 40, senderCount: 30 }],
    };
    const usersUnder = (view: { getByTestId: (id: string) => HTMLElement }) => {
      const nodes = [...view.getByTestId('sheet-flat-list').querySelectorAll('[data-kind]')];
      const everyoneAt = nodes.findIndex((node) => (node.textContent ?? '').includes('mobile.climberLogs.everyone.'));
      const usersIn = (slice: Element[]) =>
        slice.flatMap((node) =>
          [...node.querySelectorAll('[data-user]')].map((user) => user.getAttribute('data-user')),
        );
      return everyoneAt === -1
        ? { following: usersIn(nodes), everyone: [] }
        : { following: usersIn(nodes.slice(0, everyoneAt)), everyone: usersIn(nodes.slice(everyoneAt)) };
    };

    it('lists a followed climber past the cut under Following, never among strangers', () => {
      followedAuthors.userIds = ['mika', 'far-friend'];
      setLoaded([log({ userId: 'mika', comment: 'beta' })], CAPPED, true);
      // The server cannot leave followed climbers out of a cut list, so they come back here.
      setEveryone([
        [
          log({ userId: 'dave', comment: 'soft' }),
          log({ userId: 'far-friend', comment: 'from way back' }),
          log({ userId: 'mika', comment: 'again' }),
          log({ userId: 'lena' }),
        ],
      ]);
      const view = renderSheet();

      expect(everyoneQuery.calls.at(-1)?.excludeFollowed).toBe(false);
      expect(usersUnder(view)).toEqual({ following: ['mika', 'far-friend'], everyone: ['dave', 'lena'] });
    });

    it('keeps a followed climber whose send is past the cut when "Sends only" is on', () => {
      followedAuthors.userIds = ['mika', 'jonas'];
      // Inside the cut Jonas only has a no-send; his send is older than the 100 newest logs.
      setLoaded(
        [log({ userId: 'mika', status: 'send', comment: 'beta' }), log({ userId: 'jonas', status: 'attempt' })],
        CAPPED,
        true,
      );
      setEveryone([[log({ userId: 'jonas', status: 'send' }), log({ userId: 'dave', status: 'send' })]]);
      const view = renderSheet();
      fireEvent.click(chip(view, 'mobile.climberLogs.filterSendsOnly'));

      expect(usersUnder(view)).toEqual({ following: ['mika', 'jonas'], everyone: ['dave'] });
    });

    it('still keeps followed climbers out of Everyone when the follow snapshot is missing', () => {
      followedAuthors.userIds = null;
      setLoaded([log({ userId: 'mika', comment: 'beta' }), log({ userId: 'jonas', status: 'attempt' })], CAPPED, true);
      setEveryone([[log({ userId: 'jonas', status: 'send' }), log({ userId: 'dave', status: 'send' })]]);
      const view = renderSheet();
      fireEvent.click(chip(view, 'mobile.climberLogs.filterSendsOnly'));

      expect(usersUnder(view)).toEqual({ following: ['mika', 'jonas'], everyone: ['dave'] });
    });
  });

  it('gives an Everyone row no earlier-logs line to open', () => {
    setLoaded([log({ userId: 'mika', comment: 'beta' })], ONE_FOLLOWED);
    setEveryone([[log({ userId: 'dave', comment: 'beta' })]]);
    const view = renderSheet();

    const [followed, stranger] = view.getAllByTestId('climber-row');
    expect(followed.getAttribute('data-can-expand')).toBe('true');
    expect(stranger.getAttribute('data-hide-earlier')).toBe('true');
    expect(stranger.getAttribute('data-can-expand')).toBe('false');
  });

  it('names the angle in the header only while the angle chip is on', () => {
    setLoaded([log({ userId: 'mika' })], ONE_FOLLOWED);
    setEveryone([[log({ userId: 'dave' })]]);
    const view = renderSheet();

    expect(view.getByText('mobile.climberLogs.everyone.titleAtAngle:{"angle":40}')).toBeTruthy();

    fireEvent.click(chip(view, ANGLE_CHIP));
    expect(view.getByText('mobile.climberLogs.everyone.title')).toBeTruthy();
    expect(view.queryByText('mobile.climberLogs.everyone.titleAtAngle:{"angle":40}')).toBeNull();
  });

  it('sends the chips to the server instead of filtering the pages on the phone', () => {
    setLoaded([log({ userId: 'mika' })], ONE_FOLLOWED);
    const view = renderSheet();

    expect(everyoneQuery.calls.at(-1)).toEqual({
      boardName: 'kilter',
      climbUuid: 'climb-1',
      angle: 40,
      withNotes: false,
      sendsOnly: false,
      excludeFollowed: true,
      enabled: true,
    });

    fireEvent.click(chip(view, ANGLE_CHIP));
    expect(everyoneQuery.calls.at(-1)).toMatchObject({ angle: undefined });

    fireEvent.click(chip(view, 'mobile.climberLogs.filterWithNotes'));
    fireEvent.click(chip(view, 'mobile.climberLogs.filterSendsOnly'));
    expect(everyoneQuery.calls.at(-1)).toMatchObject({ angle: undefined, withNotes: true, sendsOnly: true });
  });

  it('asks the server to keep followed climbers when the Following list was cut at its cap', () => {
    setLoaded([log({ userId: 'mika' })], ONE_FOLLOWED, true);
    renderSheet();
    // A followed climber past the cut would otherwise be in neither section.
    expect(everyoneQuery.calls.at(-1)?.excludeFollowed).toBe(false);
  });

  it('never lists a climber twice, nor the viewer, whatever the server sends', () => {
    setLoaded([log({ userId: 'mika' }), log({ userId: 'jonas', angle: 45 })], {
      climberCount: 2,
      senderCount: 2,
      byAngle: [
        { angle: 40, climberCount: 1, senderCount: 1 },
        { angle: 45, climberCount: 1, senderCount: 1 },
      ],
    });
    // Jonas is hidden under Following by the angle chip. He is still followed.
    setEveryone([
      [log({ userId: 'mika' }), log({ userId: 'jonas' }), log({ userId: 'viewer' }), log({ userId: 'dave' })],
    ]);
    const view = renderSheet();

    expect(rowUsers(view)).toEqual(['mika', 'dave']);
  });

  it('keeps a log once when two pages overlap', () => {
    const repeated = log({ userId: 'dave' });
    setEveryone([
      [repeated, log({ userId: 'lena' })],
      [repeated, log({ userId: 'omar' })],
    ]);
    const view = renderSheet();

    expect(rowUsers(view)).toEqual(['dave', 'lena', 'omar']);
  });

  it('waits for the followed-climbers answer before asking', () => {
    logsQuery.state = { status: 'pending', fetchStatus: 'fetching', isLoading: true, data: undefined };
    renderSheet();
    expect(everyoneQuery.calls.at(-1)?.enabled).toBe(false);
  });

  it('does not ask while it is closed', () => {
    renderSheet({ visible: false });
    expect(everyoneQuery.calls.at(-1)?.enabled).toBe(false);
  });

  it('asks for one page per end-reach', () => {
    const fetchNextPage = vi.fn();
    setEveryone([[log({ userId: 'dave' })]], { hasNextPage: true, fetchNextPage });
    renderSheet();

    expect(list.props?.onEndReachedThreshold).toBe(0.5);
    list.props?.onEndReached?.();
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a page is already on its way', { hasNextPage: true, isFetchingNextPage: true }],
    ['there is no next page', { hasNextPage: false }],
    ['the last page failed, which waits for the retry button', { hasNextPage: true, isFetchNextPageError: true }],
  ])('does not ask on end-reach when %s', (_label, overrides) => {
    const fetchNextPage = vi.fn();
    setEveryone([[log({ userId: 'dave' })]], { ...overrides, fetchNextPage });
    renderSheet();

    list.props?.onEndReached?.();
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it('shows placeholder rows while a page is on its way', () => {
    setEveryone([[log({ userId: 'dave' })]], { hasNextPage: true, isFetchingNextPage: true });
    expect(renderSheet().getByTestId('climber-logs-page-skeleton')).toBeTruthy();

    setEveryone([], { data: undefined, isLoading: true, isSuccess: false });
    const first = renderSheet();
    expect(first.getAllByTestId('climber-logs-page-skeleton').length).toBeGreaterThan(0);
    // Nothing is known yet, so nothing is claimed.
    expect(first.container.textContent).not.toContain('mobile.climberLogs.everyone.empty');
  });

  it('says a page did not load and retries that page', () => {
    const fetchNextPage = vi.fn();
    const refetch = vi.fn();
    setEveryone([[log({ userId: 'dave' })]], { hasNextPage: true, isFetchNextPageError: true, fetchNextPage, refetch });
    const view = renderSheet();

    expect(view.getByText('mobile.climberLogs.everyone.loadMoreError')).toBeTruthy();
    fireEvent.click(view.getByText('mobile.offlineState.retry'));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('retries from the top when the first page never loaded', () => {
    const fetchNextPage = vi.fn();
    const refetch = vi.fn();
    setEveryone([], { data: undefined, isError: true, isSuccess: false, fetchNextPage, refetch });
    const view = renderSheet();

    fireEvent.click(view.getByText('mobile.offlineState.retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(fetchNextPage).not.toHaveBeenCalled();
    // Without Everyone's answer the empty line can only speak for followed climbers.
    expect(view.getByText('mobile.climberLogs.emptyNobodyLogged')).toBeTruthy();
  });

  it('offers more by hand when a page added no rows, so the list cannot stall', () => {
    const fetchNextPage = vi.fn();
    setLoaded([log({ userId: 'mika' })], ONE_FOLLOWED, true);
    // The whole page was climbers already listed under Following.
    setEveryone([[log({ userId: 'mika' })]], { hasNextPage: true, fetchNextPage });
    const view = renderSheet();

    expect(rowUsers(view)).toEqual(['mika']);
    fireEvent.click(view.getByText('mobile.climberLogs.everyone.loadMore'));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('shows nothing under the last row once every page is in', () => {
    setEveryone([[log({ userId: 'dave' })]]);
    expect(renderSheet().getByTestId('list-footer').childElementCount).toBe(0);
  });

  it('says nobody else has logged it when both sections are empty', () => {
    setLoaded([], NOBODY_FOLLOWED);
    const view = renderSheet();

    expect(view.getByText('mobile.climberLogs.everyone.empty')).toBeTruthy();
    expect(view.queryByText('mobile.climberLogs.everyone.title')).toBeNull();
  });

  it('blames the chips when they are what emptied both sections', () => {
    setLoaded([], NOBODY_FOLLOWED);
    const view = renderSheet();
    fireEvent.click(chip(view, 'mobile.climberLogs.filterSendsOnly'));

    expect(view.getByText('mobile.climberLogs.filterEmpty')).toBeTruthy();
    expect(view.queryByText('mobile.climberLogs.everyone.empty')).toBeNull();
  });

  it('shows no Everyone section and sends no request with no signal', () => {
    connectivity.snapshot = { effectiveOffline: true, reason: 'device_offline' };
    // Followed rows from an earlier visit are still held, and so are these.
    setLoaded([log({ userId: 'mika' })], ONE_FOLLOWED);
    setEveryone([[log({ userId: 'dave' })]], { hasNextPage: true });
    const view = renderSheet();

    expect(everyoneQuery.calls.at(-1)?.enabled).toBe(false);
    expect(rowUsers(view)).toEqual(['mika']);
    expect(view.queryByText('mobile.climberLogs.everyone.titleAtAngle:{"angle":40}')).toBeNull();
    expect(view.getByTestId('list-footer').childElementCount).toBe(0);
  });

  it('closes first on an Everyone row tap and opens the profile once the sheet is gone', () => {
    setEveryone([[log({ userId: 'dave' })]]);
    const view = renderSheet();

    fireEvent.click(view.getByText('open'));
    expect(view.onClose).toHaveBeenCalledTimes(1);
    expect(view.onOpenProfile).not.toHaveBeenCalled();

    sheet.props?.onFullyDismissed?.();
    expect(view.onOpenProfile).toHaveBeenCalledWith('dave');
  });
});
