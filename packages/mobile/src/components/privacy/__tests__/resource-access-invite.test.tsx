// @vitest-environment jsdom
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GET_RESOURCE_ACCESS_REQUESTS,
  GET_RESOURCE_PRIVACY,
  INVITE_RESOURCE_MEMBER,
} from '@boardsesh/graphql/operations/privacy';

// The owner's Manage access screen, driven through the real access hooks: an
// invite is a grant, so the invited climber shows as having access as soon as
// the save lands, with no request or approval step in between.

const server = vi.hoisted(() => ({
  grants: [] as Array<{ userId: string; status: string; invitedBy: string | null; displayName: string | null }>,
  calls: [] as string[],
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../SearchField', () => ({
  SearchField: ({
    value,
    onChangeText,
    placeholder,
  }: {
    value: string;
    onChangeText: (next: string) => void;
    placeholder: string;
  }) => <input aria-label={placeholder} value={value} onChange={(event) => onChangeText(event.target.value)} />,
}));
vi.mock('../../ListRow', () => ({
  ListRow: ({ title, trailing }: { title: string; trailing?: React.ReactNode }) => (
    <div>
      <span>{title}</span>
      {trailing}
    </div>
  ),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: <T,>({
    data,
    renderItem,
    keyExtractor,
    ListHeaderComponent,
  }: {
    data: T[];
    renderItem: (info: { item: T }) => React.ReactNode;
    keyExtractor: (item: T) => string;
    ListHeaderComponent?: React.ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.map((item) => (
        <div key={keyExtractor(item)} data-testid={`person-${keyExtractor(item)}`}>
          {renderItem({ item })}
        </div>
      ))}
    </div>
  ),
}));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ kind: 'board', resourceId: 'board-1' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Text', () => ({ Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span> }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) => (
    <button onClick={onPress} disabled={disabled}>
      {title}
    </button>
  ),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ spacing: [0, 4, 8, 12, 16], borderRadius: { lg: 12 }, systemColors: {}, brandColors: {} }),
}));
// The warning reads the gym over GraphQL; its own suite covers it.
vi.mock('../../board-discovery/OwnPublicGymWarning', () => ({ OwnPublicGymWarning: () => null }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'owner' } }),
  useBoard: () => ({ data: undefined }),
  useGym: () => ({ data: undefined }),
  useSearchUsers: () => ({
    data: { pages: [{ results: [{ user: { id: 'friend', displayName: 'Friend' } }] }] },
    hasNextPage: false,
    isFetchingNextPage: false,
    isError: false,
    fetchNextPage: vi.fn(),
  }),
}));
vi.mock('../../../lib/graphql/hooks/use-privacy', () => ({
  usePrivacySettings: () => ({ data: { enabled: true, privacyRevision: 0 } }),
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({ useConnectivity: () => ({ effectiveOffline: false }) }));
vi.mock('../../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false }),
}));
vi.mock('../../../lib/privacy/privacy-cache', () => ({
  refreshAfterOwnPrivacyChange: (queryClient: QueryClient) => queryClient.invalidateQueries(),
}));
vi.mock('../../../lib/graphql/client', () => ({
  getHttpClient: () => ({
    request: async (
      documentOrRequest: unknown,
      maybeVariables?: { userId?: string },
    ): Promise<Record<string, unknown>> => {
      const isRequestObject =
        typeof documentOrRequest === 'object' && documentOrRequest !== null && 'document' in documentOrRequest;
      const document = isRequestObject ? (documentOrRequest as { document: unknown }).document : documentOrRequest;
      if (document === GET_RESOURCE_PRIVACY) {
        server.calls.push('resourcePrivacy');
        return { resourcePrivacy: { kind: 'board', resourceId: 'board-1', ownerId: 'owner', audience: 'invite_only' } };
      }
      if (document === GET_RESOURCE_ACCESS_REQUESTS) {
        server.calls.push('resourceAccessRequests');
        return { resourceAccessRequests: server.grants };
      }
      if (document === INVITE_RESOURCE_MEMBER) {
        server.calls.push('inviteResourceMember');
        // What the backend writes: an approved grant, not a pending request.
        server.grants = [
          { userId: maybeVariables?.userId ?? '', status: 'approved', invitedBy: 'owner', displayName: 'Friend' },
        ];
        return { inviteResourceMember: true };
      }
      throw new Error('unexpected document');
    },
  }),
}));

import { ResourceAccessScreen } from '../ResourceAccessScreen';

beforeEach(() => {
  server.grants = [];
  server.calls = [];
});

describe('ResourceAccessScreen invite', () => {
  it('shows the invited climber with access as soon as the invite saves, with nothing to approve', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ResourceAccessScreen />
      </QueryClientProvider>,
    );
    fireEvent.change(await view.findByLabelText('privacy.searchClimbers'), { target: { value: 'Fr' } });

    const row = await view.findByTestId('person-friend');
    await waitFor(() => expect(row.textContent).toContain('privacy.invite'));
    fireEvent.click(view.getByRole('button', { name: 'privacy.invite' }));

    await waitFor(() => expect(view.getByTestId('person-friend').textContent).toContain('privacy.removeAccess'));
    const friend = view.getByTestId('person-friend');
    expect(friend.textContent).not.toContain('privacy.approve');
    expect(friend.textContent).not.toContain('privacy.invite');
    expect(server.calls.filter((call) => call === 'inviteResourceMember')).toHaveLength(1);
    expect(server.calls).not.toContain('approveResourceAccess');
  });
});
