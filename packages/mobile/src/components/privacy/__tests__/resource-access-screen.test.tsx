// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A climber who joined through a board's share link holds an ordinary approved
// grant (`invited_by` = the owner). The access screen lists them like anyone the
// owner invited by name, and Remove access works the same way.

const mutate = vi.hoisted(() => vi.fn());
const grants = vi.hoisted(() => ({
  current: [] as { userId: string; status: string; invitedBy: string | null; displayName: string | null }[],
}));

vi.mock('react-native', () => ({ View: 'div', TextInput: 'input' }));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListHeaderComponent,
  }: {
    data: unknown[];
    renderItem: (info: { item: unknown }) => React.ReactNode;
    ListHeaderComponent?: React.ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.map((item, index) => (
        <div key={index}>{renderItem({ item })}</div>
      ))}
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
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'owner-1' } }),
  useSearchUsers: () => ({ data: undefined, isError: false }),
}));
vi.mock('../../../lib/graphql/hooks/use-privacy', () => ({ usePrivacySettings: () => ({ data: { enabled: true } }) }));
vi.mock('../../../lib/graphql/hooks/use-resource-privacy', () => ({
  useResourcePrivacy: () => ({ data: { ownerId: 'owner-1' } }),
  useResourceAccessRequests: () => ({ data: grants.current, isError: false }),
  useResourceAccessAction: () => ({ mutate, isPending: false, isError: false, isSuccess: false }),
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({ useConnectivity: () => ({ effectiveOffline: false }) }));

const { ResourceAccessScreen } = await import('../ResourceAccessScreen');

beforeEach(() => {
  mutate.mockReset();
  grants.current = [];
});

describe('ResourceAccessScreen with share-link members', () => {
  it('lists a climber who joined by link as approved, and the owner can remove them', () => {
    grants.current = [{ userId: 'link-joiner', status: 'approved', invitedBy: 'owner-1', displayName: 'Link Joiner' }];
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
});
