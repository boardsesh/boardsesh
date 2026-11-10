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

  it('lists each app by name and last use, with no detail on the list itself', async () => {
    mocks.data = twoApps();
    renderSection();
    const sequence = await screen.findByTestId('connected-app-connection-sequence');
    expect(sequence.textContent).toBe('SequenceLast used 3 hours ago');
    expect(screen.getByTestId('connected-app-connection-divepeaks').textContent).toBe('DivePeaksNot used yet');
    expect(screen.getByRole('heading', { name: 'Connected apps' })).toBeTruthy();
    expect(screen.queryByText('Sees every tick in your logbook, on every board')).toBeNull();
  });

  it('opens an app to what it can see and when, with the unlisted-climbs line under the logbook', async () => {
    mocks.data = twoApps();
    renderSection();
    fireEvent.click(await screen.findByTestId('connected-app-connection-sequence'));
    const dialog = await screen.findByRole('dialog', { name: 'Sequence' });
    expect(dialog.textContent).toContain('Connected Oct 12, 2026');
    expect(dialog.textContent).toContain('Last used 3 hours ago');
    expect(within(dialog).getByRole('heading', { name: 'What Sequence can see' })).toBeTruthy();
    expect(dialog.textContent).toContain('Sees every tick in your logbook, on every board');
    expect(dialog.textContent).toContain("Including other setters' unlisted climbs and drafts you've logged");
    expect(dialog.textContent).toContain(
      "Climbs on someone else's Private or Link only Spraywall arrive without their names",
    );
    expect(dialog.textContent).toContain('Sees your display name and profile photo');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  async function openDisconnect(name: string) {
    fireEvent.click(await screen.findByTestId(`connected-app-connection-${name.toLowerCase()}`));
    const detail = await screen.findByRole('dialog', { name });
    fireEvent.click(within(detail).getByRole('button', { name: `Disconnect ${name}` }));
    return screen.findByRole('dialog', { name: `Disconnect ${name}?` });
  }

  it('asks before it disconnects, then removes the row', async () => {
    mocks.data = twoApps();
    mocks.disconnect.mockImplementation(async () => {
      mocks.data = { ...twoApps(), apps: twoApps().apps.slice(1) };
      return { disconnectApp: true };
    });
    renderSection();
    const confirm = await openDisconnect('Sequence');
    expect(confirm.textContent).toContain('Anything it already copied stays with the app.');
    expect(mocks.disconnect).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(mocks.disconnect).toHaveBeenCalledWith({ connectionId: 'connection-sequence' }));
    await waitFor(() => expect(screen.queryByTestId('connected-app-connection-sequence')).toBeNull());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('connected-app-connection-divepeaks')).toBeTruthy();
    expect(mocks.showMessage).toHaveBeenCalledWith('Sequence disconnected', 'success');
  });

  it('keeps the row and says so when Disconnect fails', async () => {
    mocks.data = twoApps();
    mocks.disconnect.mockRejectedValue(new Error('offline'));
    renderSection();
    const confirm = await openDisconnect('DivePeaks');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(mocks.showMessage).toHaveBeenCalledWith("Couldn't disconnect DivePeaks. Try again.", 'error'),
    );
    expect(screen.getByTestId('connected-app-connection-divepeaks')).toBeTruthy();
  });

  it('goes back to the app without disconnecting on Cancel', async () => {
    mocks.data = twoApps();
    renderSection();
    const confirm = await openDisconnect('Sequence');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('dialog', { name: 'Sequence' })).toBeTruthy();
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });
});
