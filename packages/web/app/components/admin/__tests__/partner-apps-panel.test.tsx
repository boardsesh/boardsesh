import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AdminPartnerApp } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import PartnerAppsPanel from '../partner-apps-panel';

const mockRequest = vi.fn();
vi.mock('react-i18next', () => ({
  useTranslation: (namespace: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(namespace, key, options),
  }),
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: 'global-admin-token' }) }));
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request: mockRequest }) }));
vi.mock('@boardsesh/graphql/operations', () => ({
  ADMIN_PARTNER_APPS: 'DIRECTORY',
  UPDATE_PARTNER_APP_LIMITS: 'LIMITS',
}));

const app: AdminPartnerApp = {
  clientId: 'app-example',
  name: 'Training Planner',
  publisherName: 'Planner Team',
  ownerUserId: 'developer',
  ownerName: 'Developer',
  ownerEmail: 'developer@example.invalid',
  disabled: false,
  suspendedAt: null,
  suspensionReason: null,
  homepageUrl: 'https://planner.example.invalid',
  createdAt: '2026-11-17T12:00:00.000Z',
  activeConnections: 12,
  newConnectionsLast24Hours: 3,
  maxActiveConnections: 25,
  maxNewConnectionsPerDay: 20,
};
const directory = { adminPartnerApps: { apps: [app], totalCount: 1, hasMore: false } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('partner app connection limits', () => {
  it('shows the developer and counts, then saves zero without disconnecting climbers', async () => {
    mockRequest
      .mockResolvedValueOnce(directory)
      .mockResolvedValueOnce({ updatePartnerAppLimits: { ...app, maxActiveConnections: 0 } });
    render(<PartnerAppsPanel />);
    expect(await screen.findByText('Training Planner')).toBeTruthy();
    expect(screen.getByText('developer@example.invalid')).toBeTruthy();
    expect(screen.getByText('12 active · 3 new in 24 hours')).toBeTruthy();
    expect(screen.getByText(/Lowering a limit keeps existing connections working/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Maximum active connections'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('LIMITS', {
        input: { clientId: 'app-example', maxActiveConnections: 0, maxNewConnectionsPerDay: 20 },
      }),
    );
    expect(await screen.findByText('Limits saved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /suspend|delete|disconnect/i })).toBeNull();
  });

  it.each(['-1', '1.5', '2147483648'])('does not submit invalid cap %s', async (cap) => {
    mockRequest.mockResolvedValue(directory);
    render(<PartnerAppsPanel />);
    await screen.findByText('Training Planner');
    fireEvent.change(screen.getByLabelText('Maximum new connections per 24 hours'), { target: { value: cap } });
    expect(screen.getByRole('button', { name: 'Save limits' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Use a whole number from 0 to 2147483647.')).toBeTruthy();
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('searches and fetches only one bounded page per next action', async () => {
    mockRequest
      .mockResolvedValueOnce({ adminPartnerApps: { apps: [app], totalCount: 51, hasMore: true } })
      .mockResolvedValueOnce(directory)
      .mockResolvedValueOnce(directory);
    render(<PartnerAppsPanel />);
    await screen.findByText('Training Planner');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('DIRECTORY', { input: { query: undefined, limit: 50, offset: 50 } }),
    );
    await screen.findByText('Training Planner');
    fireEvent.change(screen.getByLabelText('Search app, publisher, or developer'), { target: { value: 'Planner' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('DIRECTORY', { input: { query: 'Planner', limit: 50, offset: 0 } }),
    );
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });

  it('keeps edited caps available after a failed save', async () => {
    mockRequest.mockResolvedValueOnce(directory).mockRejectedValueOnce(new Error('Unavailable'));
    render(<PartnerAppsPanel />);
    await screen.findByText('Training Planner');
    fireEvent.change(screen.getByLabelText('Maximum active connections'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    expect(await screen.findByText("Couldn't save these limits. Try again.")).toBeTruthy();
    expect((screen.getByLabelText('Maximum active connections') as HTMLInputElement).value).toBe('30');
    expect(screen.getByRole('button', { name: 'Save limits' }).hasAttribute('disabled')).toBe(false);
  });
});
