// @vitest-environment jsdom
import { render, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Guarded-delete contract: swipe/a11y delete must go through the destructive
// confirm dialog before DELETE_TICK fires (a real server-side, Aurora-synced
// delete), and a success must be tracked. (The optimistic cache strip lives
// in useDeleteTick — covered by use-mutate-tick.test.tsx.)
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const deleteTick = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
const dialog = vi.hoisted(() => ({ confirm: vi.fn<(options: unknown) => Promise<boolean>>(async () => false) }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
const haptics = vi.hoisted(() => ({ hapticSelection: vi.fn(), hapticSuccess: vi.fn(), hapticError: vi.fn() }));

// Capture the per-row onDeleteRequest LogbookTab wires up, so the test can fire
// a delete without a real list renderer.
const row = vi.hoisted(() => ({
  requestDelete: null as ((method: 'swipe' | 'a11y') => void) | null,
}));

const feed = vi.hoisted(() => ({
  data: {
    pages: [
      {
        userAscentsFeed: {
          items: [
            {
              uuid: 'tick-1',
              climbUuid: 'climb-1',
              status: 'send',
              comment: null,
              climbedAt: '2026-06-15T10:00:00.000Z',
              boardType: 'kilter',
              layoutId: 1,
              angle: 40,
              boardDisplayName: 'Test Board',
            },
          ],
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
  LogbookRow: ({
    onDeleteRequest,
    ascent,
  }: {
    onDeleteRequest?: (ascent: { uuid: string }, method: 'swipe' | 'a11y') => void;
    ascent: { uuid: string };
  }) => {
    row.requestDelete = onDeleteRequest ? (method) => onDeleteRequest(ascent, method) : null;
    return createElement('div');
  },
}));
vi.mock('../LogbookDayDivider', () => ({ LogbookDayDivider: () => null }));
vi.mock('../LogbookEntryChooserSheet', () => ({ LogbookEntryChooserSheet: () => null }));
vi.mock('../LogbookEditSheet', () => ({ LogbookEditSheet: () => null }));
vi.mock('../BoardLinkPrompt', () => ({ BoardLinkPrompt: () => null }));
vi.mock('../LogbookFilterSheet', () => ({ LogbookFilterSheet: () => null }));
vi.mock('../../SearchHeader', () => ({ SearchHeader: () => null }));
vi.mock('../../../lib/haptics', () => haptics);
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { black: '#000' } }));
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));

vi.mock('../../../lib/graphql/hooks', () => ({
  useUserAscentsFeed: () => feed,
  useUserGroupedAscentsFeed: () => toGroupedFeed(feed as unknown as Record<string, unknown>),
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
// Pin the flags explicitly: kill switch off, filters off — the suite must
// not silently change code path if a provider default ever moves.
vi.mock('../../../providers/feature-flags-provider', () => ({ useFeatureFlag: () => undefined }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => toast }));

import { LogbookTab } from '../LogbookTab';
import { toGroupedFeed } from './helpers/grouped-feed-factory';

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
  dialog.confirm.mockImplementation(async () => false);
  toast.showToast.mockClear();
  haptics.hapticError.mockClear();
  row.requestDelete = null;
});

describe('LogbookTab guarded delete', () => {
  it('asks a destructive confirm and does NOT mutate when the dialog is declined', async () => {
    render(createElement(LogbookTab, { userId: 'user-1' }));
    expect(row.requestDelete).not.toBeNull();

    await fireDeleteRequest('swipe');

    expect(dialog.confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }));
    expect(deleteTick.mutate).not.toHaveBeenCalled();
  });

  it('deletes the captured uuid once confirmed and tracks the method on success', async () => {
    dialog.confirm.mockImplementation(async () => true);
    render(createElement(LogbookTab, { userId: 'user-1' }));

    await fireDeleteRequest('swipe');

    expect(deleteTick.mutate).toHaveBeenCalledWith(
      'tick-1',
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );

    // Drive the mutation's success path. (The optimistic cache strip lives in
    // useDeleteTick itself — covered by use-mutate-tick.test.tsx.)
    const mutateOptions = deleteTick.mutate.mock.calls[0][1] as { onSuccess: () => void };
    act(() => mutateOptions.onSuccess());

    expect(analytics.track).toHaveBeenCalledWith('Logbook Entry Deleted', { method: 'swipe', viaChooser: false });
  });

  it('tracks the a11y method when the delete came from an accessibility action', async () => {
    dialog.confirm.mockImplementation(async () => true);
    render(createElement(LogbookTab, { userId: 'user-1' }));

    await fireDeleteRequest('a11y');

    const mutateOptions = deleteTick.mutate.mock.calls[0][1] as { onSuccess: () => void };
    act(() => mutateOptions.onSuccess());

    expect(analytics.track).toHaveBeenCalledWith('Logbook Entry Deleted', { method: 'a11y', viaChooser: false });
  });

  it('ignores a second delete request while the confirm dialog is open', async () => {
    // Controllable confirm: hold the dialog open across both requests.
    let resolveConfirm: ((confirmed: boolean) => void) | undefined;
    dialog.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    render(createElement(LogbookTab, { userId: 'user-1' }));

    await fireDeleteRequest('swipe');
    await fireDeleteRequest('swipe'); // second swipe while the dialog is up

    expect(dialog.confirm).toHaveBeenCalledTimes(1);

    // Declining re-arms the flow for the next request.
    await act(async () => {
      resolveConfirm?.(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    dialog.confirm.mockImplementation(async () => false);
    await fireDeleteRequest('swipe');
    expect(dialog.confirm).toHaveBeenCalledTimes(2);
  });

  it('surfaces a failed delete with the error haptic + toast', async () => {
    dialog.confirm.mockImplementation(async () => true);
    render(createElement(LogbookTab, { userId: 'user-1' }));

    await fireDeleteRequest('swipe');

    const mutateOptions = deleteTick.mutate.mock.calls[0][1] as { onError: () => void };
    act(() => mutateOptions.onError());

    expect(haptics.hapticError).toHaveBeenCalled();
    expect(toast.showToast).toHaveBeenCalledWith('mobile.logbook.deleteError', 'error');
    expect(analytics.track).not.toHaveBeenCalledWith('Logbook Entry Deleted', expect.anything());
  });
});
