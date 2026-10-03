// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GET_MY_PROFILE, type MyProfile } from '@boardsesh/graphql/operations/account';

const mocks = vi.hoisted(() => ({
  graphqlRequest: vi.fn(),
  showMessage: vi.fn(),
  translate: (key: string) => key,
  wsAuthToken: { token: 'ws-token' as string | null, isLoading: false },
  session: {
    status: 'authenticated' as 'authenticated' | 'loading' | 'unauthenticated',
    data: { user: { id: 'user-1', email: 'climber@example.com' } } as {
      user?: { id?: string; email?: string | null };
    } | null,
  },
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mocks.session.data, status: mocks.session.status }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({
    token: mocks.wsAuthToken.token,
    isAuthenticated: !!mocks.wsAuthToken.token,
    isLoading: mocks.wsAuthToken.isLoading,
    error: null,
  }),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mocks.graphqlRequest }),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mocks.showMessage }),
}));

vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.translate, i18n: { language: 'en-US' } }),
}));

vi.mock('@/app/components/account/controllers-section', () => ({ default: () => null }));
vi.mock('@/app/components/account/set-password-section', () => ({
  default: ({
    hasPassword,
    linkedProviders,
    onPasswordSet,
  }: {
    hasPassword: boolean;
    linkedProviders: string[];
    onPasswordSet: () => void | Promise<void>;
  }) => (
    <div
      data-testid="set-password-section"
      data-has-password={String(hasPassword)}
      data-linked-providers={linkedProviders.join(',')}
    >
      <button onClick={() => void onPasswordSet()}>reload profile</button>
    </div>
  ),
}));
vi.mock('@/app/components/brand/logo', () => ({ default: () => null }));
vi.mock('@/app/components/back-button', () => ({ default: () => null }));

import SettingsPageContent from '../settings-page-content';

const PROFILE: MyProfile = {
  id: 'user-1',
  email: 'climber@example.com',
  displayName: 'Crimp Enjoyer',
  avatarUrl: null,
  instagramUrl: null,
  hasPassword: true,
  linkedProviders: ['google'],
  isTester: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  favoriteCount: 4,
};

describe('settings profile read over GraphQL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.wsAuthToken.token = 'ws-token';
    mocks.wsAuthToken.isLoading = false;
    mocks.session.status = 'authenticated';
    mocks.session.data = { user: { id: 'user-1', email: 'climber@example.com' } };
    mocks.graphqlRequest.mockResolvedValue({ profile: PROFILE });
  });

  it('waits for the bearer token before reading the signed-in profile', async () => {
    mocks.wsAuthToken.token = null;
    mocks.wsAuthToken.isLoading = true;

    const { rerender } = render(<SettingsPageContent />);
    expect(mocks.graphqlRequest).not.toHaveBeenCalled();

    mocks.wsAuthToken.token = 'recovered-token';
    mocks.wsAuthToken.isLoading = false;
    rerender(<SettingsPageContent />);

    await waitFor(() => expect(mocks.graphqlRequest).toHaveBeenCalledWith(GET_MY_PROFILE));
  });

  it('uses the returned account fields for the password section and refreshes them', async () => {
    render(<SettingsPageContent />);

    const passwordSection = await screen.findByTestId('set-password-section');
    expect(mocks.graphqlRequest).toHaveBeenCalledWith(GET_MY_PROFILE);
    expect(passwordSection.getAttribute('data-has-password')).toBe('true');
    expect(passwordSection.getAttribute('data-linked-providers')).toBe('google');

    screen.getByText('reload profile').click();
    await waitFor(() => expect(mocks.graphqlRequest).toHaveBeenCalledTimes(2));
  });

  it('does not query anonymously when an authenticated session has no token', async () => {
    mocks.wsAuthToken.token = null;

    render(<SettingsPageContent />);

    await waitFor(() => expect(screen.getByTestId('set-password-section')).toBeTruthy());
    expect(mocks.graphqlRequest).not.toHaveBeenCalled();
    expect(mocks.showMessage).toHaveBeenCalledWith('loading.profileError', 'error');
  });

  it('reports the missing-token error once after password set and resets after token recovery', async () => {
    mocks.wsAuthToken.token = null;
    const { rerender } = render(<SettingsPageContent />);

    await waitFor(() => expect(mocks.showMessage).toHaveBeenCalledTimes(1));
    expect(mocks.graphqlRequest).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('reload profile'));
    expect(mocks.showMessage).toHaveBeenCalledTimes(1);

    mocks.wsAuthToken.token = 'recovered-token';
    rerender(<SettingsPageContent />);
    await waitFor(() => expect(mocks.graphqlRequest).toHaveBeenCalledTimes(1));

    mocks.wsAuthToken.token = null;
    rerender(<SettingsPageContent />);
    await waitFor(() => expect(mocks.showMessage).toHaveBeenCalledTimes(2));
  });

  it('waits while the NextAuth session is still loading', async () => {
    mocks.session.status = 'loading';
    mocks.wsAuthToken.token = null;
    mocks.wsAuthToken.isLoading = false;

    render(<SettingsPageContent />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.graphqlRequest).not.toHaveBeenCalled();
  });
});
