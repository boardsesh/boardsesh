// @vitest-environment jsdom
import { createElement, type ReactElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FlashListProps = {
  data: readonly unknown[];
  renderItem: (info: { item: unknown; index: number }) => ReactElement;
  onEndReached?: () => void;
};

const state = vi.hoisted(() => ({
  mode: 'request' as string | undefined,
  offline: false,
  title: '' as string | undefined,
  list: null as FlashListProps | null,
  settings: {
    data: { enabled: true } as { enabled: boolean } | undefined,
    status: 'success',
    fetchStatus: 'idle',
    refetch: vi.fn(),
  },
  requests: {
    data: [] as { requesterId: string; displayName: string | null }[] | undefined,
    isPending: false,
    status: 'success',
    fetchStatus: 'idle',
    refetch: vi.fn(),
  },
  followers: {
    data: undefined as { pages: { users: { id: string; displayName?: string | null }[] }[] } | undefined,
    isPending: false,
    status: 'success',
    fetchStatus: 'idle',
    refetch: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  },
  action: { mutate: vi.fn(), isPending: false, isError: false, variables: undefined as { userId: string } | undefined },
  confirm: vi.fn(),
  credentialGeneration: 1,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: FlashListProps & { ListHeaderComponent?: ReactNode; ListFooterComponent?: ReactNode }) => {
    state.list = props;
    return createElement(
      'div',
      null,
      props.ListHeaderComponent,
      props.data.map((item, index) => createElement('div', { key: index }, props.renderItem({ item, index }))),
      props.ListFooterComponent,
    );
  },
}));
vi.mock('expo-router', () => ({
  Stack: {
    Screen: ({ options }: { options: { title?: string } }) => {
      state.title = options.title;
      return null;
    },
  },
  useLocalSearchParams: () => ({ mode: state.mode }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}:${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({
    title,
    accessibilityLabel,
    onPress,
    disabled,
    loading,
  }: {
    title: string;
    accessibilityLabel?: string;
    onPress: () => void;
    disabled?: boolean;
    loading?: boolean;
  }) =>
    createElement(
      'button',
      { 'aria-label': accessibilityLabel ?? title, disabled: disabled || loading, onClick: onPress },
      title,
    ),
}));
vi.mock('../../ListRow', () => ({
  ListRow: ({ title, trailing }: { title: string; trailing?: ReactNode }) =>
    createElement('div', null, createElement('span', null, title), trailing),
}));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('span', null, 'spinner') }));
vi.mock('../../OfflineState', () => ({
  OfflineState: ({ reason, onRetry }: { reason: string; onRetry?: () => void }) =>
    createElement('button', { onClick: onRetry }, `offline-state:${reason}`),
}));
vi.mock('../../ReadableColumn', () => ({ readableColumnStyle: {} }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 4: 16, 6: 24 }, borderRadius: { lg: 12 } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {} }),
}));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => state.confirm }));
vi.mock('../../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => state.credentialGeneration,
  isAuthCredentialGenerationCurrent: (generation: number) => generation === state.credentialGeneration,
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: state.offline, reason: null }),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'viewer' } }),
  useFollowers: () => state.followers,
}));
vi.mock('../../../lib/graphql/hooks/use-privacy', () => ({
  usePrivacySettings: () => state.settings,
  useIncomingFollowRequests: () => state.requests,
  usePrivacyFollowAction: () => state.action,
}));

import { PrivacyPeopleScreen } from '../PrivacyPeopleScreen';

const renderScreen = () => render(createElement(PrivacyPeopleScreen));

beforeEach(() => {
  state.mode = 'request';
  state.offline = false;
  state.title = undefined;
  state.list = null;
  state.settings = { data: { enabled: true }, status: 'success', fetchStatus: 'idle', refetch: vi.fn() };
  state.requests = {
    data: [{ requesterId: 'asker', displayName: 'Ana' }],
    isPending: false,
    status: 'success',
    fetchStatus: 'idle',
    refetch: vi.fn(),
  };
  state.followers = {
    data: {
      pages: [
        {
          users: [
            { id: 'crew-1', displayName: 'Bo' },
            { id: 'crew-2', displayName: null },
          ],
        },
      ],
    },
    isPending: false,
    status: 'success',
    fetchStatus: 'idle',
    refetch: vi.fn(),
    hasNextPage: true,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  };
  state.action = { mutate: vi.fn(), isPending: false, isError: false, variables: undefined };
  state.confirm = vi.fn();
  state.credentialGeneration = 1;
});
afterEach(cleanup);

describe('Follow requests', () => {
  it('titles the page and answers a request in one tap', () => {
    renderScreen();
    expect(state.title).toBe('privacy.requests');
    fireEvent.click(screen.getByRole('button', { name: 'privacy.approveNamed:{"name":"Ana"}' }));
    fireEvent.click(screen.getByRole('button', { name: 'privacy.declineNamed:{"name":"Ana"}' }));
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.action.mutate.mock.calls).toEqual([
      [{ action: 'approve', userId: 'asker' }],
      [{ action: 'decline', userId: 'asker' }],
    ]);
  });

  it('says so in climber words when nobody is waiting', () => {
    state.requests.data = [];
    renderScreen();
    expect(screen.getByText('privacy.noRequests')).toBeTruthy();
  });

  it('locks the buttons offline', () => {
    state.offline = true;
    renderScreen();
    expect(
      (screen.getByRole('button', { name: 'privacy.approveNamed:{"name":"Ana"}' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('Followers', () => {
  beforeEach(() => {
    state.mode = 'follower';
  });

  it('asks before removing, and a cancel removes nobody', async () => {
    state.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderScreen();
    expect(state.title).toBe('privacy.followers');
    const remove = screen.getByRole('button', { name: 'privacy.removeNamed:{"name":"Bo"}' });
    await act(async () => fireEvent.click(remove));
    expect(state.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'privacy.removeFollowerTitle:{"name":"Bo"}', destructive: true }),
    );
    expect(state.action.mutate).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(remove));
    expect(state.action.mutate).toHaveBeenCalledExactlyOnceWith({ action: 'remove', userId: 'crew-1' });
  });

  it('drops a confirmed removal when another climber signed in behind the dialog', async () => {
    let answer!: (accepted: boolean) => void;
    state.confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
    );
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'privacy.removeNamed:{"name":"Bo"}' }));
    state.credentialGeneration += 1;
    await act(async () => answer(true));
    expect(state.action.mutate).not.toHaveBeenCalled();
  });

  it('names a climber with no display name', () => {
    renderScreen();
    expect(screen.getByRole('button', { name: 'privacy.removeNamed:{"name":"privacy.climber"}' })).toBeTruthy();
  });

  it('loads one page per end-reach and never while a page is loading', () => {
    const view = renderScreen();
    act(() => state.list?.onEndReached?.());
    expect(state.followers.fetchNextPage).toHaveBeenCalledOnce();
    state.followers = { ...state.followers, isFetchingNextPage: true };
    view.rerender(createElement(PrivacyPeopleScreen));
    act(() => state.list?.onEndReached?.());
    expect(state.followers.fetchNextPage).toHaveBeenCalledOnce();
  });

  it('stops at the last page', () => {
    state.followers.hasNextPage = false;
    renderScreen();
    act(() => state.list?.onEndReached?.());
    expect(state.followers.fetchNextPage).not.toHaveBeenCalled();
  });

  it('lists a climber once even when offset pages overlap', () => {
    state.followers.data = {
      pages: [{ users: [{ id: 'crew-1', displayName: 'Bo' }] }, { users: [{ id: 'crew-1', displayName: 'Bo' }] }],
    };
    renderScreen();
    expect(state.list?.data).toHaveLength(1);
  });
});

describe('A read that fails while online', () => {
  it('says the settings failed (not "no signal") and Retry reads them again', () => {
    state.settings = { ...state.settings, data: undefined, status: 'error' };
    renderScreen();
    fireEvent.click(screen.getByRole('button', { name: 'offline-state:error' }));
    expect(state.settings.refetch).toHaveBeenCalledOnce();
    expect(screen.queryByText('spinner')).toBeNull();
  });

  it('says the request list failed instead of claiming nobody is waiting, and Retry reads it again', () => {
    state.requests = { ...state.requests, data: undefined, status: 'error' };
    renderScreen();
    expect(screen.queryByText('privacy.noRequests')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'offline-state:error' }));
    expect(state.requests.refetch).toHaveBeenCalledOnce();
    expect(state.settings.refetch).not.toHaveBeenCalled();
  });

  it('says the followers list failed instead of claiming there are none, and Retry reads it again', () => {
    state.mode = 'follower';
    state.followers = { ...state.followers, data: undefined, status: 'error' };
    renderScreen();
    expect(screen.queryByText('privacy.noFollowers')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'offline-state:error' }));
    expect(state.followers.refetch).toHaveBeenCalledOnce();
  });

  it('keeps the list and says a follow answer failed, without blaming the signal', () => {
    state.action = { ...state.action, isError: true };
    renderScreen();
    expect(screen.getByText('privacy.followFailed')).toBeTruthy();
    expect(screen.queryByText('privacy.offline')).toBeNull();
    expect(screen.getByRole('button', { name: 'privacy.approveNamed:{"name":"Ana"}' })).toBeTruthy();
  });
});
