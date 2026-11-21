import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppFeedbackReport } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import FeedbackConversation from '../feedback-conversation';
import FeedbackPanel from '../feedback-panel';

const mockRequest = vi.fn();
vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
  }),
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: 'admin-token' }) }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request: mockRequest }) }));
vi.mock('@boardsesh/graphql/operations', () => ({
  ADMIN_APP_FEEDBACK: 'LIST',
  UPDATE_APP_FEEDBACK_STATUS: 'STATUS',
  APP_BUG_REPORT_MESSAGES: 'MESSAGES',
}));

const report: AppFeedbackReport = {
  id: '42',
  source: 'drawer-bug',
  comment: 'The board list is missing my board.',
  platform: 'ios',
  createdAt: '2026-11-21T10:00:00.000Z',
  status: 'new',
  contactConsent: false,
  githubIssueNumber: 42,
  githubIssueUrl: 'https://github.com/boardsesh/boardsesh/issues/42',
  reporter: { userId: 'reporter-account', email: 'reporter@example.invalid' },
  screenshotUrls: [],
  needsReply: true,
};
const directory = {
  adminAppFeedback: {
    reports: [report],
    totalCount: 1,
    hasMore: false,
    statusCounts: { new: 1, inProgress: 0, resolved: 0, wontFix: 0 },
  },
};
const staffMessage = {
  id: '2',
  reportId: '42',
  body: 'Try refreshing your board list.',
  authorRole: 'staff',
  createdAt: '2026-11-21T11:00:00.000Z',
  deliveryStatus: 'sent',
};
const page = { appBugReportMessages: { messages: [staffMessage], hasMore: false, endCursor: '2' } };

beforeEach(() => vi.resetAllMocks());

describe('GitHub-backed feedback conversations', () => {
  it('reads the shared discussion and sends staff to GitHub with the reply tag instructions', async () => {
    mockRequest.mockResolvedValue(page);
    render(<FeedbackConversation report={report} token="admin-token" onClose={vi.fn()} />);

    expect(await screen.findByText(staffMessage.body)).toBeTruthy();
    expect(screen.getByText(/\/reply/)).toBeTruthy();
    expect(screen.getByText('Replies are shared on the linked public GitHub issue.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Reply on GitHub' }).getAttribute('href')).toBe(report.githubIssueUrl);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(mockRequest).toHaveBeenCalledWith('MESSAGES', { input: { reportId: '42', limit: 20, before: undefined } });
  });

  it('loads one older page and displays messages in order', async () => {
    mockRequest
      .mockResolvedValueOnce({ appBugReportMessages: { ...page.appBugReportMessages, hasMore: true } })
      .mockResolvedValueOnce({
        appBugReportMessages: {
          messages: [{ ...staffMessage, id: '1', authorRole: 'reporter', body: 'The list is still empty.' }],
          hasMore: false,
          endCursor: '1',
        },
      });
    render(<FeedbackConversation report={report} token="admin-token" onClose={vi.fn()} />);
    await screen.findByText(staffMessage.body);
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    const earlier = await screen.findByText('The list is still empty.');
    expect(
      earlier.compareDocumentPosition(screen.getByText(staffMessage.body)) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(mockRequest).toHaveBeenLastCalledWith('MESSAGES', { input: { reportId: '42', limit: 20, before: '2' } });
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('can retry a failed conversation load', async () => {
    mockRequest.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page);
    render(<FeedbackConversation report={report} token="admin-token" onClose={vi.fn()} />);
    await screen.findByText('Couldn’t load this conversation.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(staffMessage.body)).toBeTruthy();
  });

  it('removes withdrawn GitHub comments when the conversation refreshes', async () => {
    mockRequest.mockResolvedValueOnce(page).mockResolvedValueOnce({
      appBugReportMessages: { messages: [], hasMore: false, endCursor: null },
    });
    render(<FeedbackConversation report={report} token="admin-token" onClose={vi.fn()} />);
    await screen.findByText(staffMessage.body);
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.queryByText(staffMessage.body)).toBeNull());
  });

  it('uses GitHub timestamps when an older comment is imported later', async () => {
    mockRequest.mockResolvedValue({
      appBugReportMessages: {
        messages: [
          staffMessage,
          { ...staffMessage, id: '999', body: 'Earlier GitHub comment.', createdAt: '2026-11-21T10:30:00.000Z' },
        ],
        hasMore: false,
        endCursor: '999',
      },
    });
    render(<FeedbackConversation report={report} token="admin-token" onClose={vi.fn()} />);
    const earlier = await screen.findByText('Earlier GitHub comment.');
    expect(
      earlier.compareDocumentPosition(screen.getByText(staffMessage.body)) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('preserves canonical server order when timestamps tie and local IDs arrive out of order', async () => {
    mockRequest.mockResolvedValue({
      appBugReportMessages: {
        messages: [staffMessage, { ...staffMessage, id: '999', body: 'Earlier comment in the same second.' }],
        hasMore: false,
        endCursor: 'opaque-cursor',
      },
    });
    render(<FeedbackConversation report={report} token="admin-token" onClose={vi.fn()} />);
    const earlier = await screen.findByText('Earlier comment in the same second.');
    expect(
      earlier.compareDocumentPosition(screen.getByText(staffMessage.body)) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('filters by reporter account independently of email contact consent', async () => {
    mockRequest.mockResolvedValue(directory);
    render(<FeedbackPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'See this reporter’s bugs' }));
    await waitFor(() =>
      expect(mockRequest).toHaveBeenLastCalledWith('LIST', {
        input: {
          type: 'bugs',
          status: null,
          search: null,
          reporterId: 'reporter-account',
          needsReply: null,
          limit: 50,
          offset: 0,
        },
      }),
    );
    expect(screen.getByRole('button', { name: 'Read conversation' })).toBeTruthy();
    expect(screen.getByText('Email declined')).toBeTruthy();
  });
});
