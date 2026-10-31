import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { SEARCH_USERS } from '@boardsesh/graphql/operations/social';
import { GRANT_SUPPORTER } from '@boardsesh/graphql/operations/support-admin';
import SupporterGrantPanel from '../supporter-grant-panel';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isAuthenticated: true, isLoading: false, error: null }),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

const NOW = new Date('2026-10-31T09:00:00.000Z');

const renderPanel = () =>
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <SupporterGrantPanel getNow={() => NOW} />
    </QueryClientProvider>,
  );

const grantButton = () => screen.getByRole('button', { name: 'Grant supporter status' }) as HTMLButtonElement;
const grantCalls = () => mockRequest.mock.calls.filter(([document]) => document === GRANT_SUPPORTER);

const grantedStatus = (creditUntil: string) => ({
  grantSupporter: {
    isSupporter: true,
    showPublicly: false,
    source: 'github_sponsors',
    creditUntil,
    hasSubscription: false,
    cancelAtPeriodEnd: false,
  },
});

beforeEach(() => {
  mockRequest.mockReset();
});

describe('SupporterGrantPanel', () => {
  it('keeps Grant disabled until there is an account id and a valid month count', () => {
    renderPanel();
    expect(grantButton().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Account id'), { target: { value: 'user-1' } });
    expect(grantButton().disabled).toBe(false);

    fireEvent.change(screen.getByLabelText('Months'), { target: { value: '0' } });
    expect(grantButton().disabled).toBe(true);
    expect(screen.getByText('Whole months, 1 to 120')).toBeTruthy();
  });

  it('finds an account by name and grants GitHub Sponsors time to it', async () => {
    mockRequest.mockImplementation(async (document: unknown) => {
      if (document === SEARCH_USERS) {
        return {
          searchUsers: {
            results: [{ user: { id: 'user-42', displayName: 'Sam Sender', avatarUrl: null }, recentAscentCount: 0 }],
            totalCount: 1,
            hasMore: false,
          },
        };
      }
      return grantedStatus('2027-01-31T09:00:00.000Z');
    });
    renderPanel();

    fireEvent.change(screen.getByLabelText('Find an account'), { target: { value: 'Sam' } });
    const results = await screen.findByRole('list', { name: 'Matching accounts' });
    fireEvent.click(within(results).getByText('Sam Sender'));

    expect((screen.getByLabelText('Account id') as HTMLInputElement).value).toBe('user-42');
    expect(screen.getByText('Selected: Sam Sender')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Months'), { target: { value: '3' } });
    fireEvent.click(grantButton());

    await waitFor(() => expect(grantCalls()).toHaveLength(1));
    expect(grantCalls()[0][1]).toEqual({
      userId: 'user-42',
      source: 'github_sponsors',
      creditUntil: '2027-01-31T09:00:00.000Z',
    });
    await screen.findByText(/Supporter until/);
  });

  it('sends the admin source when chosen', async () => {
    mockRequest.mockResolvedValue(grantedStatus('2026-11-30T09:00:00.000Z'));
    renderPanel();

    fireEvent.change(screen.getByLabelText('Account id'), { target: { value: '  user-7  ' } });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Source' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Admin gift' }));
    fireEvent.click(grantButton());

    await waitFor(() => expect(grantCalls()).toHaveLength(1));
    expect(grantCalls()[0][1]).toEqual({
      userId: 'user-7',
      source: 'admin',
      creditUntil: '2026-11-30T09:00:00.000Z',
    });
  });

  it('says so when the backend refuses the grant', async () => {
    mockRequest.mockRejectedValue(new Error('No account with that id.'));
    renderPanel();

    fireEvent.change(screen.getByLabelText('Account id'), { target: { value: 'missing' } });
    fireEvent.click(grantButton());

    await screen.findByText("Couldn't grant that. Check the account id and try again.");
  });
});
