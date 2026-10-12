// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A climber who joined through a board's share link holds an ordinary approved
// grant (`invited_by` = the owner). The access screen lists them like anyone the
// owner invited by name, and Remove access works the same way.

type Grant = { userId: string; status: string; invitedBy: string | null; displayName: string | null };
const mutate = vi.hoisted(() => vi.fn());
const fetchNextGrantPage = vi.hoisted(() => vi.fn());
const grants = vi.hoisted(() => ({ pages: [] as Grant[][], hasNextPage: false }));
const search = vi.hoisted(() => ({
  pages: undefined as { results: { user: { id: string; displayName: string } }[] }[] | undefined,
}));
const statuses = vi.hoisted(() => ({ grants: [] as Grant[], loadedPages: [] as boolean[] }));

vi.mock('react-native', () => ({
  View: 'div',
  TextInput: ({ value, onChangeText }: { value: string; onChangeText: (text: string) => void }) => (
    <input aria-label="search" value={value} onChange={(event) => onChangeText(event.target.value)} />
  ),
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListHeaderComponent,
    onEndReached,
  }: {
    data: unknown[];
    renderItem: (info: { item: unknown }) => React.ReactNode;
    ListHeaderComponent?: React.ReactNode;
    onEndReached?: () => void;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.map((item, index) => (
        <div key={index}>{renderItem({ item })}</div>
      ))}
      <button onClick={onEndReached}>list-end</button>
    </div>
  ),
}));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ kind: 'board', resourceId: 'board-1' }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ spacing: [0, 4, 8, 12, 16], systemColors: {}, brandColors: {} }),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) => <button onClick={onPress}>{title}</button>,
}));
// The warning reads the gym over GraphQL; its own suite covers it.
vi.mock('../../board-discovery/OwnPublicGymWarning', () => ({ OwnPublicGymWarning: () => null }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'owner-1' } }),
  useBoard: () => ({ data: undefined }),
  useGym: () => ({ data: undefined }),
  useSearchUsers: (_text: string, enabled: boolean) => ({
    data: enabled && search.pages ? { pages: search.pages } : undefined,
    isError: false,
    hasNextPage: false,
  }),
}));
vi.mock('../../../lib/graphql/hooks/use-privacy', () => ({ usePrivacySettings: () => ({ data: { enabled: true } }) }));
vi.mock('../../../lib/graphql/hooks/use-resource-privacy', () => ({
  useResourcePrivacy: () => ({ data: { ownerId: 'owner-1' } }),
  useResourceAccessRequests: () => ({
    data: { pages: grants.pages },
    isError: false,
    hasNextPage: grants.hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: fetchNextGrantPage,
  }),
  useResourceGrantStatuses: () => ({ ...statuses, isError: false }),
  useResourceAccessAction: () => ({ mutate, isPending: false, isError: false, isSuccess: false }),
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({ useConnectivity: () => ({ effectiveOffline: false }) }));

const { ResourceAccessScreen } = await import('../ResourceAccessScreen');

beforeEach(() => {
  mutate.mockReset();
  fetchNextGrantPage.mockReset();
  grants.pages = [];
  grants.hasNextPage = false;
  search.pages = undefined;
  statuses.grants = [];
  statuses.loadedPages = [];
});

describe('ResourceAccessScreen with share-link members', () => {
  it('lists a climber who joined by link as approved, and the owner can remove them', () => {
    grants.pages = [[{ userId: 'link-joiner', status: 'approved', invitedBy: 'owner-1', displayName: 'Link Joiner' }]];
    const view = render(<ResourceAccessScreen />);

    expect(view.getByText('Link Joiner')).toBeTruthy();
    expect(view.queryByText('privacy.approve')).toBeNull();
    fireEvent.click(view.getByText('privacy.removeAccess'));
    expect(mutate).toHaveBeenCalledWith({
      action: 'revoke',
      kind: 'board',
      resourceId: 'board-1',
      userId: 'link-joiner',
    });
  });
  it('loads the next page of members at the end of the list', () => {
    grants.pages = [[{ userId: 'link-joiner', status: 'approved', invitedBy: 'owner-1', displayName: 'Link Joiner' }]];
    grants.hasNextPage = true;
    const view = render(<ResourceAccessScreen />);
    fireEvent.click(view.getByText('list-end'));
    expect(fetchNextGrantPage).toHaveBeenCalledTimes(1);
  });

  it("offers Remove for a searched member the loaded list doesn't reach, using the server's grant", () => {
    // The loaded page holds someone else; the searched climber joined later.
    grants.pages = [[{ userId: 'early', status: 'approved', invitedBy: 'owner-1', displayName: 'Early' }]];
    search.pages = [{ results: [{ user: { id: 'late-joiner', displayName: 'Late Joiner' } }] }];
    statuses.grants = [{ userId: 'late-joiner', status: 'approved', invitedBy: 'owner-1', displayName: 'Late Joiner' }];
    statuses.loadedPages = [true];
    const view = render(<ResourceAccessScreen />);
    fireEvent.change(view.getByLabelText('search'), { target: { value: 'late' } });

    expect(view.getByText('Late Joiner')).toBeTruthy();
    expect(view.queryByText('privacy.invite')).toBeNull();
    fireEvent.click(view.getByText('privacy.removeAccess'));
    expect(mutate).toHaveBeenCalledWith({
      action: 'revoke',
      kind: 'board',
      resourceId: 'board-1',
      userId: 'late-joiner',
    });
  });

  it('holds back a page of search results until their grants are known', () => {
    search.pages = [{ results: [{ user: { id: 'late-joiner', displayName: 'Late Joiner' } }] }];
    statuses.loadedPages = [false];
    const view = render(<ResourceAccessScreen />);
    fireEvent.change(view.getByLabelText('search'), { target: { value: 'late' } });
    expect(view.queryByText('Late Joiner')).toBeNull();
  });
});
