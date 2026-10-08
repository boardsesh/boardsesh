// @vitest-environment jsdom
vi.mock('../../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
vi.mock('../../PressableSurface', async () => {
  const { Pressable } = await import('react-native');
  const { createElement } = await import('react');
  return {
    PressableSurface: (props: React.ComponentProps<typeof Pressable>) =>
      createElement(Pressable, { ...props, onPress: props.disabled ? undefined : props.onPress }),
  };
});
import { render, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Guarded-delete contract: swipe/a11y delete must go through the destructive
// confirm dialog before DELETE_TICK fires (a real server-side, Aurora-synced
// delete), and a success must be tracked. (The optimistic cache strip lives
// in useDeleteTick — covered by use-mutate-tick.test.tsx.)
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const owner = vi.hoisted(() => {
  const owner = {
    scope: 'scope',
    getDeleteScope: (): string => owner.scope,
    scheduleDelete: vi.fn((_request: unknown) => true),
  };
  return owner;
});
vi.mock('../../../providers/logbook-delete-provider', () => ({
  usePendingLogbookDeletes: () => new Set(),
  useLogbookDeleteActions: () => owner,
}));
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
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: unknown) => styles,
    hairlineWidth: 1,
  },
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
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: {},
  borderRadius: {},
}));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({ systemColors: {}, brandColors: {} }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), useFocusEffect: () => {} }));
vi.mock('../../../lib/open-climb-in-play-drawer', () => ({ openClimbInPlayDrawer: vi.fn() }));
vi.mock('../../../lib/tick-to-climb', () => ({ tickToClimb: vi.fn() }));
vi.mock('../../../lib/playlists/board-details-for-playlist', () => ({ getBoardConfigForPlaylist: vi.fn() }));
vi.mock('../../../providers/drawer-host-provider', () => ({
  useDrawerHost: () => ({ openPlayDrawer: vi.fn(), openClimbActions: vi.fn() }),
}));
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
  owner.scope = 'scope';
  analytics.track.mockClear();
  owner.scheduleDelete.mockClear();
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
    expect(owner.scheduleDelete).not.toHaveBeenCalled();
  });

  it.each(['swipe', 'a11y'] as const)(
    'schedules the captured UUID only after confirming %s deletion',
    async (method) => {
      dialog.confirm.mockImplementation(async () => true);
      render(createElement(LogbookTab, { userId: 'user-1' }));
      await fireDeleteRequest(method);
      expect(owner.scheduleDelete).toHaveBeenCalledWith(
        expect.objectContaining({ uuid: 'tick-1', method, viaChooser: false, onSettled: expect.any(Function) }),
      );
      expect(analytics.track).not.toHaveBeenCalled();
    },
  );

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

  it('captures the origin scope before awaiting a destructive confirmation', async () => {
    let finish: (confirmed: boolean) => void = () => {};
    dialog.confirm.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    render(createElement(LogbookTab, { userId: 'user-1' }));
    await fireDeleteRequest('swipe');
    owner.scope = 'new-account:board';
    await act(async () => {
      finish(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(owner.scheduleDelete).toHaveBeenCalledWith(
      expect.objectContaining({ uuid: 'tick-1', originScope: 'scope' }),
    );
  });

  it('re-arms the local flow after the owner settles an Undo', async () => {
    dialog.confirm.mockImplementation(async () => true);
    render(createElement(LogbookTab, { userId: 'user-1' }));
    await fireDeleteRequest('swipe');
    const request = owner.scheduleDelete.mock.calls[0][0] as unknown as { onSettled: () => void };
    act(() => request.onSettled());
    await fireDeleteRequest('swipe');
    expect(owner.scheduleDelete).toHaveBeenCalledTimes(2);
  });
});
