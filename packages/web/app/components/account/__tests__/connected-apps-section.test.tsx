/**
 * Settings › Connected apps on the website: a climber can see every app they
 * connected and end any of them from a browser (#6981 F16), with the #7387
 * line about unlisted climbs beside what a logbook app reads.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectedApps } from '@boardsesh/shared-schema';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'climber-a' } }, status: 'authenticated' }),
}));

const mocks = vi.hoisted(() => ({
  authenticated: true,
  data: undefined as ConnectedApps | undefined,
  disconnect: vi.fn<(variables: { connectionId: string }) => Promise<{ disconnectApp: boolean }>>(),
  showMessage: vi.fn(),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: mocks.authenticated ? 'token' : null, isAuthenticated: mocks.authenticated }),
}));
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mocks.showMessage }),
}));
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({
    request: async (document: unknown, variables?: { connectionId: string }) => {
      const source = typeof document === 'string' ? document : String((document as { document: unknown }).document);
      if (source.includes('disconnectApp')) return mocks.disconnect(variables!);
      return { myConnectedApps: mocks.data };
    },
  }),
}));

import ConnectedAppsSection from '../connected-apps-section';

const HOUR_MS = 3_600_000;

function twoApps(): ConnectedApps {
  return {
    partnerAppsEnabled: true,
    apps: [
      {
        connectionId: 'connection-sequence',
        name: 'Sequence',
        publisherName: null,
        scopes: ['profile:read', 'logbook:read', 'offline_access'],
        connectedAt: '2026-10-12T08:00:00.000Z',
        lastUsedAt: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
        suspended: false,
      },
      {
        connectionId: 'connection-divepeaks',
        name: 'DivePeaks',
        publisherName: null,
        scopes: ['logbook:read'],
        connectedAt: '2026-09-01T08:00:00.000Z',
        lastUsedAt: null,
        suspended: false,
      },
    ],
  };
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConnectedAppsSection />
    </QueryClientProvider>,
  );
}

describe('ConnectedAppsSection', () => {
  beforeEach(() => {
    mocks.authenticated = true;
    mocks.data = undefined;
    mocks.disconnect.mockReset();
    mocks.showMessage.mockReset();
  });

  it('shows nothing while partner apps are off and nothing is connected', async () => {
    mocks.data = { apps: [], partnerAppsEnabled: false };
    const { container } = renderSection();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.innerHTML).toBe('');
  });

  it('says nothing is connected once partner apps are on', async () => {
    mocks.data = { apps: [], partnerAppsEnabled: true };
    renderSection();
    expect(
      await screen.findByText('No apps connected yet. Apps you connect to your Boardsesh account show up here.'),
    ).toBeTruthy();
  });

  it('lists each app with what it reads and when, and the unlisted-climbs line under the logbook', async () => {
    mocks.data = twoApps();
    renderSection();
    const sequence = await screen.findByTestId('connected-app-connection-sequence');
    expect(within(sequence).getByRole('heading', { name: 'Sequence' })).toBeTruthy();
    expect(sequence.textContent).toContain('Connected Oct 12, 2026');
    expect(sequence.textContent).toContain('Last used 3 hours ago');
    expect(sequence.textContent).toContain('Sees every tick in your logbook, on every board');
    expect(sequence.textContent).toContain(
      'Including unlisted climbs and drafts in your logbook, even ones set by others',
    );
    expect(sequence.textContent).toContain('Sees your display name and profile photo');
    expect(screen.getByTestId('connected-app-connection-divepeaks').textContent).toContain('Not used yet');
    expect(screen.getByRole('heading', { name: 'Connected apps' })).toBeTruthy();
  });

  it('asks before it disconnects, then removes the row', async () => {
    mocks.data = twoApps();
    mocks.disconnect.mockImplementation(async () => {
      mocks.data = { ...twoApps(), apps: twoApps().apps.slice(1) };
      return { disconnectApp: true };
    });
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Sequence' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect Sequence?' });
    expect(dialog.textContent).toContain('Anything it already copied stays with the app.');
    expect(mocks.disconnect).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith({ connectionId: 'connection-sequence' }));
    await waitFor(() => expect(screen.queryByTestId('connected-app-connection-sequence')).toBeNull());
    expect(screen.getByTestId('connected-app-connection-divepeaks')).toBeTruthy();
    expect(mocks.showMessage).toHaveBeenCalledWith('Sequence disconnected', 'success');
  });

  it('keeps the row and says so when Disconnect fails', async () => {
    mocks.data = twoApps();
    mocks.disconnect.mockRejectedValue(new Error('offline'));
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect DivePeaks' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(mocks.showMessage).toHaveBeenCalledWith("Couldn't disconnect DivePeaks. Try again.", 'error'),
    );
    expect(screen.getByTestId('connected-app-connection-divepeaks')).toBeTruthy();
  });

  it('cancels without disconnecting', async () => {
    mocks.data = twoApps();
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Sequence' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });
});
