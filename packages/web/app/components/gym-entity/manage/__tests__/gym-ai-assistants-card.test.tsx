import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import GymAiAssistantsCard from '../gym-ai-assistants-card';

vi.mock('react-i18next', () => ({
  useTranslation: (namespace?: string) => ({ t: (key: string) => tFromCatalog(namespace, key) }),
}));
vi.mock('@/app/components/providers/session-provider', () => ({
  useBrowserSession: () => ({ data: { user: { id: 'gym-owner' } } }),
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: 'test-token' }) }));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement>>(
    function MockLocaleLink(props, ref) {
      return <a {...props} ref={ref} />;
    },
  ),
}));
const request = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({ createGraphQLHttpClient: () => ({ request }) }));

beforeEach(() => {
  request.mockReset();
});
afterEach(cleanup);

function renderCard(invitationRequired = false) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <GymAiAssistantsCard invitationRequired={invitationRequired} />
    </QueryClientProvider>,
  );
}

describe('gym assistant connections', () => {
  it('does not count a training app as a gym assistant', async () => {
    request.mockResolvedValue({ myConnectedApps: { apps: [{ scopes: ['logbook:read'], suspended: false }] } });
    renderCard();
    expect(await screen.findByText('No assistant connected yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Connect an assistant' }).getAttribute('href')).toBe('/developers/gym-mcp');
    expect(screen.getByRole('link', { name: 'Manage connections' }).getAttribute('href')).toBe('/settings');
  });

  it('recognizes gym connections separately from paused access', async () => {
    request.mockResolvedValue({ myConnectedApps: { apps: [{ scopes: ['gyms:read'], suspended: false }] } });
    renderCard();
    expect(await screen.findByText('An assistant is connected')).toBeTruthy();
  });

  it('tells managers to wait for an invitation before starting pilot sign-in', async () => {
    request.mockResolvedValue({ myConnectedApps: { apps: [] } });
    renderCard(true);
    expect(screen.getByText(/Wait for a Boardsesh invitation before starting sign-in/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Read pilot access details' }).getAttribute('href')).toBe(
      '/developers/gym-mcp',
    );
    expect(screen.queryByRole('link', { name: 'Connect an assistant' })).toBeNull();
    expect(await screen.findByText('No assistant connected yet')).toBeTruthy();
  });

  it('shows suspended gym connections as paused', async () => {
    request.mockResolvedValue({ myConnectedApps: { apps: [{ scopes: ['gyms:read'], suspended: true }] } });
    renderCard();
    expect(await screen.findByText('Assistant access is paused')).toBeTruthy();
  });

  it('does not claim a failed query means no assistant is connected', async () => {
    request.mockRejectedValue(new Error('offline'));
    renderCard();
    expect(await screen.findByText('Check your connections in Settings')).toBeTruthy();
    expect(screen.queryByText('No assistant connected yet')).toBeNull();
  });
});
