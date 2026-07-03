// @vitest-environment jsdom
import { render, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Grouped-mode contract: in date-ordered views the tab renders (climb, day)
// groups as single rows — best outcome carries the row, tries sum — and
// edit/delete on a multi-entry group routes through the day-entries chooser
// (never acting on the whole group).
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const deleteTick = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
const dialog = vi.hoisted(() => ({ confirm: vi.fn<(options: unknown) => Promise<boolean>>(async () => false) }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const haptics = vi.hoisted(() => ({ hapticSelection: vi.fn(), hapticSuccess: vi.fn(), hapticError: vi.fn() }));

// Capture the per-row onDeleteRequest LogbookTab wires up, so the test can fire
// a delete without a real list renderer.
const row = vi.hoisted(() => ({
  requestDelete: null as ((method: 'swipe' | 'a11y') => void) | null,
  requestEdit: null as (() => void) | null,
  props: null as Record<string, unknown> | null,
}));
const chooser = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
const editSheet = vi.hoisted(() => ({ ascent: null as { uuid: string } | null }));

const GROUP_ITEMS = [
  {
    uuid: 'tick-send',
    climbUuid: 'climb-1',
    status: 'send',
    attemptCount: 2,
    quality: 4,
    comment: null,
    climbedAt: '2026-06-15T12:00:00.000Z',
    boardType: 'kilter',
    layoutId: 1,
    angle: 40,
    boardDisplayName: 'Test Board',
  },
  {
    uuid: 'tick-burn',
    climbUuid: 'climb-1',
    status: 'attempt',
    attemptCount: 3,
    quality: null,
    comment: null,
    climbedAt: '2026-06-15T10:00:00.000Z',
    boardType: 'kilter',
    layoutId: 1,
    angle: 40,
    boardDisplayName: 'Test Board',
  },
];
const groupedFeed = vi.hoisted(() => ({
  data: {
    pages: [
      {
        userGroupedAscentsFeed: {
          groups: [] as unknown[],
          totalCount: 1,
          hasMore: false,
        },
      },
    ],
  },
  isPending: false,
  isRefetching: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}));
const flatFeed = vi.hoisted(() => ({
  data: { pages: [] as unknown[] },
  isPending: false,
  isRefetching: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}));

vi.mock('../../../lib/analytics', () => ({ track: analytics.track }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  RefreshControl: () => null,
  Pressable: () => null,
  useWindowDimensions: () => ({ fontScale: 1, width: 375, height: 800 }),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios', select: (specifics: Record<string, unknown>) => specifics.ios ?? specifics.default },
}));

// Render every list row through renderItem so the mocked LogbookRow mounts and
// captures its onDeleteRequest.
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
  }: {
    data: Array<unknown>;
    renderItem: (info: { item: unknown; index: number }) => ReactNode;
  }) => createElement('div', null, ...data.map((item, index) => renderItem({ item, index }))),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../LogbookRow', () => ({
  LogbookRow: (props: {
    onDeleteRequest?: (ascent: { uuid: string }, method: 'swipe' | 'a11y') => void;
    onEdit?: (ascent: { uuid: string }) => void;
    ascent: { uuid: string };
  }) => {
    row.props = props as unknown as Record<string, unknown>;
    row.requestDelete = props.onDeleteRequest ? (method) => props.onDeleteRequest?.(props.ascent, method) : null;
    row.requestEdit = props.onEdit ? () => props.onEdit?.(props.ascent) : null;
    return createElement('div');
  },
}));
vi.mock('../LogbookEntryChooserSheet', () => ({
  LogbookEntryChooserSheet: (props: Record<string, unknown>) => {
    chooser.props = props;
    return createElement('div');
  },
}));
vi.mock('../LogbookDayDivider', () => ({ LogbookDayDivider: () => null }));
vi.mock('../LogbookEditSheet', () => ({
  LogbookEditSheet: ({ ascent }: { ascent: { uuid: string } | null }) => {
    editSheet.ascent = ascent;
    return null;
  },
}));
vi.mock('../LogbookFilterSheet', () => ({ LogbookFilterSheet: () => null }));
vi.mock('../../SearchHeader', () => ({ SearchHeader: () => null }));
vi.mock('../../../lib/haptics', () => haptics);
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { black: '#000' } }));
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useUserAscentsFeed: () => flatFeed,
  useUserGroupedAscentsFeed: () => groupedFeed,
  useGrades: () => ({ data: [] }),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: {}, borderRadius: {} }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {} }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), useFocusEffect: () => {} }));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: vi.fn() }));
vi.mock('../../../lib/tick-to-climb', () => ({ tickToClimb: vi.fn() }));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({ getBoardConfigForPlaylist: vi.fn() }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: vi.fn(), openClimbActions: vi.fn() }),
}));
vi.mock('@boardsesh/board-react', () => ({ useDeleteTick: () => deleteTick }));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => dialog.confirm }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => toast }));

import { LogbookTab } from '../LogbookTab';

// handleDeleteRequest runs a fire-and-forget async chain; a macrotask turn
// drains ALL of its pending microtasks (counting Promise.resolve() flushes is
// brittle — it breaks whenever an await is added to the chain).
async function fireDeleteRequest(method: 'swipe' | 'a11y') {
  await act(async () => {
    row.requestDelete?.(method);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  analytics.track.mockClear();
  deleteTick.mutate.mockClear();
  dialog.confirm.mockClear();
  dialog.confirm.mockImplementation(async () => true);
  toast.showToast.mockClear();
  haptics.hapticError.mockClear();
  row.requestDelete = null;
  row.requestEdit = null;
  row.props = null;
  chooser.props = null;
  editSheet.ascent = null;
  groupedFeed.data.pages[0].userGroupedAscentsFeed.groups = [
    { key: 'climb-1-2026-06-15', climbUuid: 'climb-1', date: '2026-06-15', items: GROUP_ITEMS },
  ];
});

describe('LogbookTab grouped mode', () => {
  it('renders the group as one row: best outcome carries it, tries sum', () => {
    render(createElement(LogbookTab, { userId: 'user-1' }));
    expect(row.props).not.toBeNull();
    // Best outcome = the send, even though the burn is also in the group.
    expect((row.props?.ascent as { uuid: string }).uuid).toBe('tick-send');
    // 2 + 3 tries across the day.
    expect(row.props?.groupTries).toBe(5);
  });

  it('routes delete on a multi-entry group through the chooser, then deletes the picked tick', async () => {
    render(createElement(LogbookTab, { userId: 'user-1' }));

    await fireDeleteRequest('swipe');

    // No direct confirm — the chooser opens instead.
    expect(dialog.confirm).not.toHaveBeenCalled();
    expect(chooser.props).not.toBeNull();
    expect(chooser.props?.intent).toBe('delete');

    // Picking the burn routes to the guarded delete for THAT tick.
    const onPickDelete = chooser.props?.onPick as ((entry: { uuid: string }) => void) | undefined;
    expect(onPickDelete).toBeDefined();
    await act(async () => {
      onPickDelete?.(GROUP_ITEMS[1]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(dialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }));
    expect(deleteTick.mutate).toHaveBeenCalledWith('tick-burn', expect.anything());
  });

  it('routes edit on a multi-entry group through the chooser to the edit sheet', async () => {
    render(createElement(LogbookTab, { userId: 'user-1' }));

    await act(async () => {
      row.requestEdit?.();
    });
    expect(chooser.props?.intent).toBe('edit');

    const onPickEdit = chooser.props?.onPick as ((entry: { uuid: string }) => void) | undefined;
    expect(onPickEdit).toBeDefined();
    await act(async () => {
      onPickEdit?.(GROUP_ITEMS[0]);
    });
    expect(editSheet.ascent?.uuid).toBe('tick-send');
    expect(deleteTick.mutate).not.toHaveBeenCalled();
  });

  it('re-arms the delete flow after the chooser is dismissed without a pick', async () => {
    render(createElement(LogbookTab, { userId: 'user-1' }));

    await fireDeleteRequest('swipe');
    expect(chooser.props).not.toBeNull();

    // Dismiss without picking: nothing deletes, no confirm fires. The stub only
    // captures on render, so clear it to make the reopen below provable.
    const onDismiss = chooser.props?.onDismiss as (() => void) | undefined;
    expect(onDismiss).toBeDefined();
    await act(async () => {
      onDismiss?.();
    });
    chooser.props = null;
    expect(dialog.confirm).not.toHaveBeenCalled();
    expect(deleteTick.mutate).not.toHaveBeenCalled();

    // The chooserOpenRef guard reset — a fresh gesture opens the chooser again.
    // Read via a local: the `= null` above narrows chooser.props for the rest
    // of the scope, and TS can't see the re-render repopulating it.
    await fireDeleteRequest('swipe');
    const reopenedProps = chooser.props as Record<string, unknown> | null;
    expect(reopenedProps).not.toBeNull();
    expect(reopenedProps?.intent).toBe('delete');
  });

  it('acts directly when the group has a single entry', async () => {
    groupedFeed.data.pages[0].userGroupedAscentsFeed.groups = [
      { key: 'solo', climbUuid: 'climb-1', date: '2026-06-15', items: [GROUP_ITEMS[0]] },
    ];
    render(createElement(LogbookTab, { userId: 'user-1' }));

    await fireDeleteRequest('swipe');

    expect(chooser.props).toBeNull();
    expect(deleteTick.mutate).toHaveBeenCalledWith('tick-send', expect.anything());
  });

  it('opens the edit sheet directly for a single-entry group, skipping the chooser', async () => {
    groupedFeed.data.pages[0].userGroupedAscentsFeed.groups = [
      { key: 'solo', climbUuid: 'climb-1', date: '2026-06-15', items: [GROUP_ITEMS[0]] },
    ];
    render(createElement(LogbookTab, { userId: 'user-1' }));

    await act(async () => {
      row.requestEdit?.();
    });

    expect(chooser.props).toBeNull();
    expect(editSheet.ascent?.uuid).toBe('tick-send');
  });
});
