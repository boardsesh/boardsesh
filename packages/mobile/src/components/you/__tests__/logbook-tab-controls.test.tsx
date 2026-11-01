// @vitest-environment jsdom
// The list-play hook has its own suite; here a tap only has to reach it.
vi.mock('../../../lib/playlists/use-tick-list-activation', () => ({ useTickListActivation: () => vi.fn() }));
vi.mock('../../../providers/logbook-delete-provider', () => ({
  usePendingLogbookDeletes: () => new Set(),
  useLogbookDeleteActions: () => ({ getDeleteScope: () => 'scope', scheduleDelete: vi.fn(() => true) }),
}));
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOGBOOK_FILTERS,
  DEFAULT_LOGBOOK_SORT,
  logbookSortFor,
  type LogbookFilterState,
  type LogbookSortState,
} from '@boardsesh/logbook';
import type { Capsule, MenuCapsule, RailCapsule, SheetCapsule } from '../../filter-capsules/CapsuleRow.types';
import type { FilterToken } from '../../../lib/filter-tokens';
import type { LogbookPinnableChipKind } from '../../../lib/logbook-pinnable-chips';
import type { LogbookBoardOption } from '../use-logbook-board-options';

type SheetCapture = {
  filters: LogbookFilterState;
  sort: LogbookSortState;
  name: string;
  viewerIsOwner: boolean;
  matchCount: number | null;
  today: Date;
  onDismiss: () => void;
  onChangeFilters: (patch: Partial<LogbookFilterState>) => void;
  onChangeSort: (sort: LogbookSortState) => void;
  onNameChange: (text: string) => void;
  onClearName: () => void;
  onReset: () => void;
  onOpenSetters: (beforePush?: () => void) => boolean;
  initialSection?: 'when';
};

const captured = vi.hoisted(() => ({
  capsules: [] as Capsule[],
  capsuleRowRenders: 0,
  openRail: undefined as string | null | undefined,
  tokens: [] as FilterToken[],
  sheet: null as SheetCapture | null,
  feedInput: undefined as Record<string, unknown> | undefined,
  feedEnabled: undefined as boolean | undefined,
  groupedEnabled: undefined as boolean | undefined,
}));
const platformState = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' | 'web' }));
const pinState = vi.hoisted(() => ({
  pinned: ['grade', 'status', 'date', 'angle', 'sort'] as LogbookPinnableChipKind[],
}));
const boardState = vi.hoisted(() => ({ options: [] as LogbookBoardOption[] }));
const appState = vi.hoisted(() => ({ listener: null as null | ((status: string) => void) }));
const focusState = vi.hoisted(() => ({ callbacks: new Set<() => void>() }));
const routerState = vi.hoisted(() => ({ push: vi.fn() }));
const analytics = vi.hoisted(() => ({ track: vi.fn() }));

const feed = vi.hoisted(() => ({
  data: { pages: [{ userAscentsFeed: { items: [], totalCount: 42 } }] },
  isPending: false,
  isError: false,
  isRefetching: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));

// ReadableColumn pads by the side safe area; a portrait phone has none.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platformState.os;
    },
  },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  RefreshControl: () => null,
  useWindowDimensions: () => ({ fontScale: 1, width: 375, height: 800 }),
  AppState: {
    addEventListener: (_event: string, listener: (status: string) => void) => {
      appState.listener = listener;
      return {
        remove: () => {
          appState.listener = null;
        },
      };
    },
  },
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: unknown) => styles,
    hairlineWidth: 1,
  },
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
}));

// Renders the empty state when there are no rows, so "Clear filters" can be pressed.
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({ data, ListEmptyComponent }: { data: unknown[]; ListEmptyComponent?: ReactNode }) =>
    createElement('div', { 'data-testid': 'flash-list' }, data.length === 0 ? ListEmptyComponent : null),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options == null ? key : `${key}:${Object.values(options).join(',')}`,
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('../../filter-capsules/CapsuleRow', () => ({
  CapsuleRow: ({ capsules }: { capsules: Capsule[] }) => {
    captured.capsules = capsules;
    captured.capsuleRowRenders += 1;
    return createElement('div', { 'data-testid': 'capsule-row' });
  },
}));
vi.mock('../LogbookFacetRail', () => ({
  LogbookFacetRail: ({ openRail }: { openRail: string | null }) => {
    captured.openRail = openRail;
    return null;
  },
}));
vi.mock('../../search/FilterTokenRow', () => ({
  FilterTokenRow: ({ tokens }: { tokens: FilterToken[] }) => {
    captured.tokens = tokens;
    return null;
  },
}));
vi.mock('../LogbookFilterSheet', () => ({
  LogbookFilterSheet: (props: SheetCapture) => {
    captured.sheet = props;
    return createElement('div', { 'data-testid': 'filter-sheet' });
  },
}));

vi.mock('../LogbookRow', () => ({ LogbookRow: () => createElement('div') }));
vi.mock('../LogbookDayDivider', () => ({ LogbookDayDivider: () => null }));
vi.mock('../LogbookEntryChooserSheet', () => ({ LogbookEntryChooserSheet: () => null }));
vi.mock('../LogbookEditSheet', () => ({ LogbookEditSheet: () => null }));
vi.mock('../BoardLinkPrompt', () => ({ BoardLinkPrompt: () => null }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));

vi.mock('../../../lib/graphql/hooks', () => ({
  useUserAscentsFeed: (
    _userId: string | undefined,
    input: Record<string, unknown>,
    options?: { enabled?: boolean },
  ) => {
    captured.feedInput = input;
    captured.feedEnabled = options?.enabled;
    return feed;
  },
  useUserGroupedAscentsFeed: (
    _userId: string | undefined,
    input: Record<string, unknown>,
    options?: { enabled?: boolean },
  ) => {
    captured.feedInput = input;
    captured.groupedEnabled = options?.enabled;
    return toGroupedFeed(feed as unknown as Record<string, unknown>);
  },
  useGrades: () => ({ data: [] }),
}));
vi.mock('../use-logbook-board-options', () => ({ useLogbookBoardOptions: () => boardState.options }));
vi.mock('../../../lib/logbook-pinned-chips-store', () => ({
  useLogbookPinnedChips: () => ({
    pinned: pinState.pinned,
    loaded: true,
    isPinned: (kind: LogbookPinnableChipKind) => pinState.pinned.includes(kind),
    togglePin: vi.fn(),
  }),
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ gradeFormat: 'v', formatGrade: (grade: string | null | undefined) => grade ?? null }),
}));
vi.mock('../../../lib/routing/scoped-navigation', () => ({ useScopedRouter: () => ({ push: routerState.push }) }));
vi.mock('../../../lib/logbook-prefs-store', () => ({
  loadLogbookPrefs: vi.fn(() => Promise.resolve(null)),
  saveLogbookPrefs: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../theme/tokens', () => ({ opacity: { disabled: 0.5 }, spacing: {}, borderRadius: {} }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { black: '#000' } }));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({ systemColors: {}, brandColors: {} }),
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useFocusEffect: (callback: () => void) => {
    focusState.callbacks.add(callback);
  },
}));
vi.mock('../../../lib/tick-to-climb', () => ({ tickToClimb: vi.fn() }));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({ renderBoardToPlaylistConfig: vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn(), hapticSuccess: vi.fn(), hapticError: vi.fn() }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: vi.fn(), openClimbActions: vi.fn() }),
}));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueriesData: vi.fn() }),
  onlineManager: { isOnline: () => true, subscribe: () => () => {} },
}));
vi.mock('../../../providers/feature-flags-provider', () => ({ useFeatureFlag: () => undefined }));

// use-logbook-search, use-today and @boardsesh/logbook run for real, so the
// test asserts the real wiring from a capsule to the feed input.
import { LogbookTab } from '../LogbookTab';
import { loadLogbookPrefs, saveLogbookPrefs } from '../../../lib/logbook-prefs-store';
import { emitLogbookSetterSelection } from '../../../lib/logbook-setter-handoff';
import { resetTodayForTests } from '../../../hooks/use-today';
import { toGroupedFeed } from './helpers/grouped-feed-factory';

const BOARDS: LogbookBoardOption[] = [
  { boardType: 'kilter', label: 'Kilter', layouts: [] },
  { boardType: 'tension', label: 'Tension', layouts: [] },
];

function capsule<K extends Capsule['kind']>(key: string, kind: K): Extract<Capsule, { kind: K }> {
  const found = captured.capsules.find((candidate) => candidate.key === key);
  if (!found || found.kind !== kind) throw new Error(`no ${kind} capsule "${key}"`);
  return found as Extract<Capsule, { kind: K }>;
}

async function renderTab(props: Partial<Parameters<typeof LogbookTab>[0]> = {}) {
  const view = render(createElement(LogbookTab, { userId: 'climber-1', ...props }));
  // Let the persisted prefs hydrate (a resolved promise) so the feed opens.
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}

function composedHeader(controls: ReactNode) {
  return createElement('div', { 'data-testid': 'profile-header' }, controls);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 5, 30, 10, 0, 0));
  resetTodayForTests();
  captured.capsules = [];
  captured.capsuleRowRenders = 0;
  captured.openRail = undefined;
  captured.tokens = [];
  captured.sheet = null;
  captured.feedInput = undefined;
  captured.feedEnabled = undefined;
  captured.groupedEnabled = undefined;
  platformState.os = 'ios';
  pinState.pinned = ['grade', 'status', 'date', 'angle', 'sort'];
  boardState.options = [];
  appState.listener = null;
  focusState.callbacks.clear();
  routerState.push.mockReset();
  analytics.track.mockClear();
  vi.mocked(loadLogbookPrefs).mockClear().mockResolvedValue(null);
  vi.mocked(saveLogbookPrefs).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LogbookTab controls', () => {
  it.each(['ios', 'android', 'web'] as const)('draws the capsule row and no search field on %s', async (os) => {
    platformState.os = os;
    const { queryByPlaceholderText, queryByTestId } = await renderTab({ renderHeader: composedHeader });
    expect(queryByTestId('capsule-row')).not.toBeNull();
    expect(captured.capsules.map((entry) => entry.key)).toEqual([
      'filters',
      'grade',
      'status',
      'date',
      'angle',
      'sort',
    ]);
    expect(queryByPlaceholderText('mobile.logbook.searchPlaceholder')).toBeNull();
    expect(queryByTestId('search-header')).toBeNull();
  });

  it('draws the capsule row in flow on a public profile too, under a heading whose scope follows the board', async () => {
    boardState.options = BOARDS;
    pinState.pinned = ['board'];
    const { getByText, queryByText } = await renderTab({ viewerIsOwner: false });
    expect(getByText('tabs.logbook')).toBeTruthy();
    expect(getByText('mobile.filter.allBoards')).toBeTruthy();
    act(() => capsule('board', 'menu').onSelect('tension'));
    expect(captured.feedInput).toMatchObject({ boardType: 'tension' });
    expect(queryByText('mobile.filter.allBoards')).toBeNull();
    expect(getByText('Tension')).toBeTruthy();
  });

  it('drops the heading inside the composed profile header', async () => {
    const { queryByText, getByTestId } = await renderTab({ renderHeader: composedHeader });
    expect(getByTestId('profile-header')).toBeTruthy();
    expect(queryByText('tabs.logbook')).toBeNull();
  });

  it('gates the feed until persisted prefs hydrate', async () => {
    let resolveLoad: (value: null) => void = () => {};
    vi.mocked(loadLogbookPrefs).mockReturnValueOnce(
      new Promise<null>((resolve) => {
        resolveLoad = resolve;
      }),
    );
    render(createElement(LogbookTab, { userId: 'climber-1' }));
    expect(captured.groupedEnabled).toBe(false);
    await act(async () => {
      resolveLoad(null);
      await Promise.resolve();
    });
    expect(captured.groupedEnabled).toBe(true);
  });

  it('commits a status capsule pick into the feed and tracks where it came from', async () => {
    await renderTab();
    act(() => capsule('status', 'menu').onSelect('sends'));
    expect(captured.feedInput).toMatchObject({ statusMode: 'send', flashOnly: false });
    expect(analytics.track).toHaveBeenCalledWith('Logbook Filter Changed', {
      fields: 'flashOnly,includeAttempts,includeSends',
      surface: 'capsule',
    });
    expect((capsule('filters', 'sheet') as SheetCapsule).count).toBe(1);
  });

  it('switches the sort from its capsule and tracks the key and order', async () => {
    await renderTab();
    act(() => capsule('sort', 'menu').onSelect('grade'));
    expect(captured.feedInput).toMatchObject({ sortBy: 'hardest', sortOrder: 'desc' });
    expect(analytics.track).toHaveBeenCalledWith('Logbook Sort Changed', {
      preset: 'hardest',
      sortKey: 'grade',
      direction: 'desc',
      surface: 'capsule',
    });
    expect((capsule('sort', 'menu') as MenuCapsule).label).toBe('mobile.logbook.sortLabel.hardest');
  });

  it('opens one inline rail at a time and closes it when the sheet opens', async () => {
    await renderTab();
    expect(captured.openRail).toBeNull();
    act(() => capsule('grade', 'rail').onPress());
    expect(captured.openRail).toBe('grade');
    expect((capsule('grade', 'rail') as RailCapsule).expanded).toBe(true);
    act(() => capsule('angle', 'rail').onPress());
    expect(captured.openRail).toBe('angle');
    expect((capsule('grade', 'rail') as RailCapsule).expanded).toBe(false);
    act(() => capsule('angle', 'rail').onPress());
    expect(captured.openRail).toBeNull();

    act(() => capsule('grade', 'rail').onPress());
    act(() => capsule('filters', 'sheet').onPress());
    expect(captured.openRail).toBeNull();
    expect(captured.sheet).not.toBeNull();
  });

  it('hides the open rail with its capsule when the capsule is unpinned', async () => {
    const view = await renderTab();
    act(() => capsule('grade', 'rail').onPress());
    expect(captured.openRail).toBe('grade');
    pinState.pinned = ['status', 'date', 'angle', 'sort'];
    view.rerender(createElement(LogbookTab, { userId: 'climber-1', viewerIsOwner: true }));
    expect(captured.openRail).toBeNull();
  });

  it('takes the climb name from the sheet, debounced, and names it in a removable token', async () => {
    await renderTab();
    act(() => capsule('filters', 'sheet').onPress());
    act(() => captured.sheet?.onNameChange('crimp '));
    expect(captured.feedInput).not.toHaveProperty('climbName');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(captured.feedInput).toMatchObject({ climbName: 'crimp' });
    expect(analytics.track).toHaveBeenCalledWith('Logbook Searched', { length: 5 });
    expect(captured.tokens.map((token) => token.label)).toEqual(['mobile.logbook.capsules.nameToken:crimp']);
    expect((capsule('filters', 'sheet') as SheetCapsule).count).toBe(1);
    expect(captured.sheet?.name).toBe('crimp');

    act(() => captured.tokens[0].clear());
    expect(captured.feedInput).not.toHaveProperty('climbName');
    expect(captured.tokens).toEqual([]);
  });

  it('names an active filter whose capsule is not pinned, and clears it from the token', async () => {
    await renderTab();
    act(() => capsule('filters', 'sheet').onPress());
    act(() => captured.sheet?.onChangeFilters({ benchmarkOnly: true }));
    expect(captured.feedInput).toMatchObject({ benchmarkOnly: true });
    expect(analytics.track).toHaveBeenCalledWith('Logbook Filter Changed', {
      fields: 'benchmarkOnly',
      surface: 'sheet',
    });
    expect(captured.tokens.map((token) => token.key)).toEqual(['benchmarks']);
    act(() => captured.tokens[0].clear());
    expect(captured.feedInput).not.toHaveProperty('benchmarkOnly');
    expect(analytics.track).toHaveBeenCalledWith('Logbook Filter Changed', {
      fields: 'benchmarkOnly',
      surface: 'token',
    });
  });

  it("hands the sheet the flat feed's entry total, and no count on the date feed", async () => {
    await renderTab();
    act(() => capsule('filters', 'sheet').onPress());
    // The default (date, newest first) order reads the grouped feed.
    // The date feed's total counts server groups, not the rows shown: no count.
    expect(captured.sheet?.matchCount).toBeNull();
    act(() => captured.sheet?.onChangeSort(logbookSortFor('climbName', 'asc')));
    expect(captured.sheet?.matchCount).toBe(42);
  });

  it('resets filters, sort and name from the sheet', async () => {
    await renderTab();
    act(() => capsule('filters', 'sheet').onPress());
    act(() => {
      captured.sheet?.onChangeFilters({ minQuality: 4 });
      captured.sheet?.onChangeSort(logbookSortFor('attemptCount', 'desc'));
      captured.sheet?.onNameChange('crimp');
      vi.advanceTimersByTime(300);
    });
    act(() => captured.sheet?.onReset());
    expect(captured.sheet?.filters).toEqual(DEFAULT_LOGBOOK_FILTERS);
    expect(captured.sheet?.sort).toEqual(DEFAULT_LOGBOOK_SORT);
    expect(captured.sheet?.name).toBe('');
  });

  it('rolls a rolling window over when the app comes back on a new day', async () => {
    await renderTab();
    act(() => capsule('date', 'menu').onSelect('last7'));
    expect(captured.feedInput?.fromDate).toBe(new Date(2026, 5, 24).toISOString());

    vi.setSystemTime(new Date(2026, 6, 1, 9, 0, 0));
    act(() => appState.listener?.('active'));
    expect(captured.feedInput?.fromDate).toBe(new Date(2026, 5, 25).toISOString());
  });

  it('rolls over on focus too, and keeps the same day all day', async () => {
    await renderTab();
    act(() => capsule('date', 'menu').onSelect('month'));
    const sameDayInput = captured.feedInput;
    vi.setSystemTime(new Date(2026, 5, 30, 23, 0, 0));
    act(() => focusState.callbacks.forEach((callback) => callback()));
    expect(captured.feedInput).toBe(sameDayInput);

    vi.setSystemTime(new Date(2026, 6, 1, 0, 5, 0));
    act(() => focusState.callbacks.forEach((callback) => callback()));
    expect(captured.feedInput?.fromDate).toBe(new Date(2026, 6, 1).toISOString());
  });

  it('pushes the setter picker from its capsule and takes back only its own picks', async () => {
    pinState.pinned = ['setter'];
    await renderTab();
    act(() => capsule('filters', 'sheet').onPress());
    act(() => captured.sheet?.onChangeFilters({ boardType: 'kilter', layoutIds: [1] }));
    act(() => capsule('setter', 'sheet').onPress());
    expect(routerState.push).toHaveBeenCalledTimes(1);
    const [{ pathname, params }] = routerState.push.mock.calls[0] as [
      { pathname: string; params: Record<string, string> },
    ];
    expect(pathname).toBe('/users/[userId]/logbook-setters');
    expect(params).toMatchObject({ userId: 'climber-1', setters: '[]', boardType: 'kilter', layoutIds: '[1]' });

    act(() => emitLogbookSetterSelection({ handoffId: 'someone-else', setterUsernames: ['nope'], apply: false }));
    expect(captured.feedInput).not.toHaveProperty('setterUsernames');

    act(() => emitLogbookSetterSelection({ handoffId: params.handoffId, setterUsernames: ['alex'], apply: false }));
    expect(captured.feedInput).toMatchObject({ setterUsernames: ['alex'] });
    expect(analytics.track).toHaveBeenCalledWith('Logbook Filter Changed', {
      fields: 'setterUsernames',
      surface: 'setter_picker',
    });
    // Still open: the back chevron returns to the sheet.
    expect(captured.sheet).not.toBeNull();

    // "Show climbs" returns to the list: the suspended sheet closes.
    act(() =>
      emitLogbookSetterSelection({ handoffId: params.handoffId, setterUsernames: ['alex', 'sam'], apply: true }),
    );
    expect(captured.feedInput).toMatchObject({ setterUsernames: ['alex', 'sam'] });
  });

  it("keeps filters on someone else's logbook to the visit: never reads or writes your saved set", async () => {
    await renderTab({ viewerIsOwner: false });
    act(() => capsule('status', 'menu').onSelect('sends'));
    expect(captured.feedInput).toMatchObject({ statusMode: 'send' });
    expect(loadLogbookPrefs).not.toHaveBeenCalled();
    expect(saveLogbookPrefs).not.toHaveBeenCalled();
  });

  it('saves filters on your own logbook', async () => {
    await renderTab();
    act(() => capsule('status', 'menu').onSelect('sends'));
    expect(saveLogbookPrefs).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: expect.objectContaining({ includeSends: true, includeAttempts: false }) }),
    );
  });

  it('clears every filter and the name from an emptied list, keeping the sort', async () => {
    const { getByText } = await renderTab();
    act(() => capsule('status', 'menu').onSelect('sends'));
    act(() => capsule('sort', 'menu').onSelect('grade'));
    act(() => capsule('filters', 'sheet').onPress());
    act(() => {
      captured.sheet?.onChangeFilters({ benchmarkOnly: true, minQuality: 2 });
      captured.sheet?.onNameChange('crimp');
      vi.advanceTimersByTime(300);
    });
    expect(captured.feedInput).toMatchObject({ climbName: 'crimp', benchmarkOnly: true, sortBy: 'hardest' });
    expect(getByText('mobile.logbook.emptyFiltered')).toBeTruthy();

    fireEvent.click(getByText('mobile.logbook.clearFilters'));
    expect(captured.sheet?.filters).toEqual(DEFAULT_LOGBOOK_FILTERS);
    expect(captured.sheet?.name).toBe('');
    expect(captured.sheet?.sort).toEqual(logbookSortFor('grade', 'desc'));
    expect(captured.feedInput).not.toHaveProperty('climbName');
    expect(captured.feedInput).toMatchObject({ sortBy: 'hardest', statusMode: 'both' });
    expect(analytics.track).toHaveBeenCalledWith('Logbook Filter Changed', { fields: 'all', surface: 'empty_state' });
  });

  it('says nothing about filters on an unfiltered empty logbook, and never "your" on someone else\'s', async () => {
    const own = await renderTab();
    expect(own.getByText('mobile.logbook.empty')).toBeTruthy();
    expect(own.queryByText('mobile.logbook.clearFilters')).toBeNull();
    own.unmount();
    const other = await renderTab({ viewerIsOwner: false });
    expect(other.getByText('mobile.logbook.emptyOther')).toBeTruthy();
  });

  it('opens the sheet on When from "Custom…", and at the top from Filters', async () => {
    const view = await renderTab();
    act(() => capsule('date', 'menu').actions?.[0].onPress());
    expect(captured.sheet?.initialSection).toBe('when');
    expect(captured.sheet?.filters.dateWindow).toBe('custom');
    act(() => captured.sheet?.onDismiss());
    expect(view.queryByTestId('filter-sheet')).toBeNull();
    act(() => capsule('filters', 'sheet').onPress());
    expect(captured.sheet?.initialSection).toBeUndefined();
  });

  it('pushes one setter picker for a double tap, and another once the first hands back', async () => {
    pinState.pinned = ['setter'];
    await renderTab();
    act(() => {
      capsule('setter', 'sheet').onPress();
      capsule('setter', 'sheet').onPress();
    });
    expect(routerState.push).toHaveBeenCalledTimes(1);
    const [{ params }] = routerState.push.mock.calls[0] as [{ params: Record<string, string> }];
    act(() => emitLogbookSetterSelection({ handoffId: params.handoffId, setterUsernames: [], apply: false }));
    act(() => capsule('setter', 'sheet').onPress());
    expect(routerState.push).toHaveBeenCalledTimes(2);
  });

  it('lets go of a push that never landed after a beat', async () => {
    pinState.pinned = ['setter'];
    await renderTab();
    act(() => capsule('setter', 'sheet').onPress());
    act(() => capsule('setter', 'sheet').onPress());
    expect(routerState.push).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    act(() => capsule('setter', 'sheet').onPress());
    expect(routerState.push).toHaveBeenCalledTimes(2);
  });

  it('refuses the push without a climber, before the sheet suspends', async () => {
    await renderTab({ userId: undefined });
    act(() => capsule('filters', 'sheet').onPress());
    const beforePush = vi.fn();
    let pushed = true;
    act(() => {
      pushed = captured.sheet?.onOpenSetters(beforePush) ?? true;
    });
    expect(pushed).toBe(false);
    expect(beforePush).not.toHaveBeenCalled();
    expect(routerState.push).not.toHaveBeenCalled();
  });

  it('closes the sheet when the picker asks to show results', async () => {
    const view = await renderTab();
    act(() => capsule('filters', 'sheet').onPress());
    act(() => {
      captured.sheet?.onOpenSetters();
    });
    const [{ params }] = routerState.push.mock.calls[0] as [{ params: Record<string, string> }];
    expect(view.queryByTestId('filter-sheet')).not.toBeNull();
    act(() => emitLogbookSetterSelection({ handoffId: params.handoffId, setterUsernames: [], apply: true }));
    expect(view.queryByTestId('filter-sheet')).toBeNull();
  });
});
