// @vitest-environment jsdom
import { createElement, useEffect, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppBugReport, AppBugReportMessage } from '@boardsesh/shared-schema';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  retry: vi.fn(),
  read: vi.fn(),
  refresh: vi.fn(),
  earlier: vi.fn(),
  uuid: vi.fn(),
  messages: [] as AppBugReportMessage[],
  hasMore: false,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  RefreshControl: () => null,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: vi.fn() }),
  useLocalSearchParams: () => ({ id: '42' }),
  useIsFocused: () => true,
  useFocusEffect: (callback: () => void) => useEffect(callback, [callback]),
}));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => 0 }));
vi.mock('expo-crypto', () => ({ randomUUID: mocks.uuid }));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true, isLoading: false }) }));
vi.mock('../../../hooks/use-current-user-id', () => ({
  useStoredUserId: () => ({ userId: 'reporter', isLoading: false }),
}));
vi.mock('../../../hooks/use-stack-screen-options', () => ({ useStackScreenOptions: () => ({}) }));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../hooks/use-offline-query-state', () => ({ useOfflineQueryState: () => ({ isBlocked: false }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { background: '#fff', secondaryBackground: '#eee', label: '#000', error: '#f00' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16, 6: 24 }, borderRadius: { md: 8, lg: 12 } }));
vi.mock('../../../lib/open-url', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../../../lib/format-relative-time', () => ({ formatRelativeTime: () => 'now' }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../OfflineState', () => ({ OfflineState: () => null }));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => createElement('span', null, 'loading') }));
vi.mock('../../AccessibleTextInput', () => ({
  AccessibleTextInput: ({
    value,
    onChangeText,
    editable,
  }: {
    value: string;
    onChangeText: (next: string) => void;
    editable: boolean;
  }) =>
    createElement('textarea', {
      value,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => onChangeText(event.target.value),
      disabled: !editable,
    }),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled }, title),
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListEmptyComponent,
  }: {
    data: AppBugReportMessage[];
    renderItem: (row: { item: AppBugReportMessage }) => ReactNode;
    ListHeaderComponent: ReactNode;
    ListEmptyComponent: ReactNode;
  }) =>
    createElement(
      'div',
      null,
      ListHeaderComponent,
      data.length
        ? data.map((item) => createElement('div', { key: item.id, 'data-message': item.id }, renderItem({ item })))
        : ListEmptyComponent,
    ),
}));
vi.mock('../../../lib/feedback/use-bug-reports', () => ({
  useAppBugReportMessages: () => ({
    data: { pages: [{ messages: mocks.messages }] },
    refetch: mocks.refresh,
    fetchNextPage: mocks.earlier,
    hasNextPage: mocks.hasMore,
    isFetchingNextPage: false,
    isRefetching: false,
    isPending: false,
    isError: false,
  }),
  useSendAppBugReportMessage: () => ({ mutateAsync: mocks.send, isPending: false }),
  useMarkAppBugReportRead: () => ({ mutate: mocks.read }),
  useRetryAppBugReportMessage: () => ({ mutate: mocks.retry, isPending: false }),
  useAppBugReport: () => ({ data: null }),
}));

import { BugReportConversation } from '../BugReportScreen';

const report: AppBugReport = {
  id: '42',
  comment: 'The board did not connect.',
  createdAt: '2026-11-21T10:00:00Z',
  status: 'new',
  screenshotUrls: [],
  githubIssueNumber: 99,
  githubIssueUrl: 'https://github.com/boardsesh/boardsesh/issues/99',
  canReply: true,
};
const message = (id: string, deliveryStatus: 'pending' | 'sent' | 'failed', body: string): AppBugReportMessage => ({
  id,
  reportId: '42',
  body,
  deliveryStatus,
  authorRole: 'reporter',
  createdAt: '2026-11-21T10:00:00Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.messages = [];
  mocks.hasMore = false;
  mocks.send.mockResolvedValue(message('1', 'pending', 'More detail'));
  mocks.uuid
    .mockReturnValueOnce('11111111-2222-4333-8444-555555555555')
    .mockReturnValue('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
});

describe('bug-report conversation', () => {
  it('discloses public posting beside an in-app composer and optional tracker link', () => {
    render(<BugReportConversation accountId="reporter" report={report} />);
    expect(screen.getByText('bugReports.publicNotice')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'bugReports.github' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'bugReports.send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText('bugReports.private')).toBeNull();
  });

  it('retains a failed draft and reuses its idempotency id when the user retries', async () => {
    mocks.send.mockRejectedValueOnce(new Error('lost response'));
    render(<BugReportConversation accountId="reporter" report={report} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'More detail' } });
    fireEvent.click(screen.getByRole('button', { name: 'bugReports.send' }));
    await screen.findByText('bugReports.sendError');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('More detail');
    fireEvent.click(screen.getByRole('button', { name: 'bugReports.send' }));
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''));
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[0][0]).toEqual(mocks.send.mock.calls[1][0]);
    expect(mocks.send.mock.calls[0][0]).toEqual({
      reportId: '42',
      body: 'More detail',
      clientMutationId: '11111111-2222-4333-8444-555555555555',
    });
  });

  it('shows queued and failed delivery states and retries the persisted message id', () => {
    mocks.messages = [message('2', 'failed', 'Failed reply'), message('1', 'pending', 'Queued reply')];
    const { container } = render(<BugReportConversation accountId="reporter" report={report} />);
    expect(screen.getByText('bugReports.pending')).toBeTruthy();
    expect(screen.getByText('bugReports.failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'bugReports.retrySend' }));
    expect(mocks.retry).toHaveBeenCalledWith('2');
    expect([...container.querySelectorAll('[data-message]')].map((row) => row.getAttribute('data-message'))).toEqual([
      '1',
      '2',
    ]);
  });

  it('keeps unlinked reports read-only and refreshes the link when requested', () => {
    const refreshReport = vi.fn();
    render(
      <BugReportConversation
        accountId="reporter"
        report={{ ...report, canReply: false }}
        onRefreshReport={refreshReport}
      />,
    );
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('bugReports.readOnly')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'bugReports.retry' }));
    expect(refreshReport).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('loads one earlier page per tap and clears the bell group after loading messages', () => {
    mocks.hasMore = true;
    render(<BugReportConversation accountId="reporter" report={report} />);
    fireEvent.click(screen.getByRole('button', { name: 'bugReports.loadOlder' }));
    expect(mocks.earlier).toHaveBeenCalledOnce();
    expect(mocks.read).toHaveBeenCalledOnce();
  });
});
