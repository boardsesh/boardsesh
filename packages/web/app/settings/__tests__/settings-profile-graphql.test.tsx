// @vitest-environment jsdom

/**
 * The settings profile form after issue #1884 moved it off
 * `GET/PUT /api/internal/profile` onto `Query.profile` / `Mutation.updateProfile`.
 *
 * The regression this file exists to catch: the REST route accepted an empty
 * display name and wrote NULL, while the GraphQL input schema rejects `''`
 * (min(1)) and treats `null` as "clear it". A save that sends `''` would fail
 * validation where it used to succeed.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { GET_MY_PROFILE, UPDATE_MY_PROFILE, type MyProfile } from '@boardsesh/graphql/operations/account';

const mocks = vi.hoisted(() => ({
  graphqlRequest: vi.fn(),
  showMessage: vi.fn(),
  refreshPartyProfile: vi.fn(async () => {}),
  updateSession: vi.fn(async () => null),
  wsAuthToken: { token: 'ws-token' as string | null, isLoading: false },
  session: {
    status: 'authenticated' as 'authenticated' | 'loading' | 'unauthenticated',
    data: { user: { id: 'user-1', email: 'climber@example.com' } } as {
      user?: { id?: string; email?: string | null };
    } | null,
  },
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mocks.session.data, status: mocks.session.status, update: mocks.updateSession }),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mocks.graphqlRequest }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({
    token: mocks.wsAuthToken.token,
    isAuthenticated: !!mocks.wsAuthToken.token,
    isLoading: mocks.wsAuthToken.isLoading,
    error: null,
  }),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mocks.showMessage }),
}));

vi.mock('@/app/components/party-manager/party-profile-context', () => ({
  usePartyProfile: () => ({ refreshProfile: mocks.refreshPartyProfile }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

vi.mock('@/app/lib/i18n/use-locale-router', () => ({
  useLocaleRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/app/hooks/use-grade-format', () => ({
  useGradeFormat: () => ({ gradeFormat: 'v-grade', setGradeFormat: vi.fn(), loaded: true }),
}));

vi.mock('@/app/hooks/use-healthkit-sync', () => ({
  useHealthKitAutoSync: () => ({ enabled: false, loaded: true, setEnabled: vi.fn() }),
}));

vi.mock('@/app/lib/healthkit/healthkit-bridge', () => ({
  isHealthKitAvailable: async () => false,
}));

// The page is a shell around a lot of unrelated sections; stub them so this
// test only exercises the profile form.
vi.mock('@/app/components/settings/aurora-credentials-section', () => ({ default: () => null }));
vi.mock('@/app/components/settings/controllers-section', () => ({ default: () => null }));
vi.mock('@/app/components/settings/watch-pairing-section', () => ({ default: () => null }));
vi.mock('@/app/components/settings/delete-account-section', () => ({ default: () => null }));
vi.mock('@/app/components/settings/set-password-section', () => ({
  default: ({ hasPassword, linkedProviders }: { hasPassword: boolean; linkedProviders: string[] }) => (
    <div
      data-testid="set-password-section"
      data-has-password={String(hasPassword)}
      data-linked-providers={linkedProviders.join(',')}
    />
  ),
}));
vi.mock('@/app/components/brand/logo', () => ({ default: () => null }));
vi.mock('@/app/components/back-button', () => ({ default: () => null }));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

import SettingsPageContent from '../settings-page-content';

const LOADED_PROFILE: MyProfile = {
  id: 'user-1',
  email: 'climber@example.com',
  displayName: 'Crimp Enjoyer',
  avatarUrl: 'https://cdn/avatar.png',
  instagramUrl: 'https://instagram.com/crimps',
  hasPassword: true,
  linkedProviders: ['google'],
  isTester: false,
  createdAt: '2024-01-01T00:00:00.000Z',
  favoriteCount: 4,
};

function mockLoadThenSave(saved: MyProfile = LOADED_PROFILE) {
  mocks.graphqlRequest.mockImplementation(async (document: unknown) => {
    if (document === GET_MY_PROFILE) return { profile: LOADED_PROFILE };
    if (document === UPDATE_MY_PROFILE) return { updateProfile: saved };
    return {};
  });
}

function lastUpdateInput(): Record<string, unknown> {
  const call = mocks.graphqlRequest.mock.calls.findLast((args) => args[0] === UPDATE_MY_PROFILE);
  if (!call) throw new Error('UPDATE_MY_PROFILE was never sent');
  return (call[1] as { input: Record<string, unknown> }).input;
}

async function renderLoadedSettings() {
  render(<SettingsPageContent />);
  await waitFor(() => {
    expect(screen.getByDisplayValue('Crimp Enjoyer')).toBeTruthy();
  });
}

describe('settings profile form over GraphQL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.wsAuthToken.token = 'ws-token';
    mocks.wsAuthToken.isLoading = false;
    mocks.session.status = 'authenticated';
    mocks.session.data = { user: { id: 'user-1', email: 'climber@example.com' } };
    mockLoadThenSave();
  });

  it('waits for the ws-auth token before reading the profile', async () => {
    mocks.wsAuthToken.token = null;
    mocks.wsAuthToken.isLoading = true;

    render(<SettingsPageContent />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // An unauthenticated `profile` query resolves to null and would render an
    // empty form over the user's real settings.
    expect(mocks.graphqlRequest).not.toHaveBeenCalled();
  });

  // ws-auth has its own retry budget and can settle with no token at all. Only
  // the profile card needs it, so the rest of /settings (Aurora credentials,
  // account deletion, grade format) must still render rather than sitting
  // behind the page-level spinner forever.
  it('stops the page spinner when ws-auth settles without a token', async () => {
    mocks.wsAuthToken.token = null;
    mocks.wsAuthToken.isLoading = false;

    render(<SettingsPageContent />);

    await waitFor(() => {
      expect(screen.getByTestId('set-password-section')).toBeTruthy();
    });
    expect(mocks.graphqlRequest).not.toHaveBeenCalled();
    expect(mocks.showMessage).toHaveBeenCalledWith('loading.profileError', 'error');
  });

  it('seeds the form and the password section from the profile query', async () => {
    await renderLoadedSettings();

    expect(mocks.graphqlRequest).toHaveBeenCalledWith(GET_MY_PROFILE);
    expect(screen.getByDisplayValue('https://instagram.com/crimps')).toBeTruthy();

    const passwordSection = screen.getByTestId('set-password-section');
    expect(passwordSection.getAttribute('data-has-password')).toBe('true');
    expect(passwordSection.getAttribute('data-linked-providers')).toBe('google');
  });

  it('sends null, not an empty string, when a field is cleared', async () => {
    await renderLoadedSettings();

    fireEvent.change(screen.getByDisplayValue('Crimp Enjoyer'), { target: { value: '   ' } });
    fireEvent.change(screen.getByDisplayValue('https://instagram.com/crimps'), { target: { value: '' } });
    fireEvent.click(screen.getByText('profile.save'));

    await waitFor(() => {
      expect(mocks.graphqlRequest).toHaveBeenCalledWith(UPDATE_MY_PROFILE, expect.anything());
    });

    // `''` fails UpdateProfileInputSchema's min(1); null is the clear signal.
    expect(lastUpdateInput()).toMatchObject({ displayName: null, instagramUrl: null });
  });

  it('sends the edited display name and Instagram URL', async () => {
    await renderLoadedSettings();

    fireEvent.change(screen.getByDisplayValue('Crimp Enjoyer'), { target: { value: 'Slab Merchant' } });
    fireEvent.change(screen.getByDisplayValue('https://instagram.com/crimps'), {
      target: { value: 'https://instagram.com/slabs' },
    });
    fireEvent.click(screen.getByText('profile.save'));

    await waitFor(() => {
      expect(mocks.graphqlRequest).toHaveBeenCalledWith(UPDATE_MY_PROFILE, expect.anything());
    });

    expect(lastUpdateInput()).toMatchObject({
      displayName: 'Slab Merchant',
      instagramUrl: 'https://instagram.com/slabs',
      avatarUrl: 'https://cdn/avatar.png',
    });
  });

  it('surfaces the resolver error message when the save fails', async () => {
    await renderLoadedSettings();

    mocks.graphqlRequest.mockImplementation(async (document: unknown) => {
      if (document === GET_MY_PROFILE) return { profile: LOADED_PROFILE };
      throw Object.assign(new Error('opaque'), {
        response: { errors: [{ message: 'Could not save your profile. Please try again.' }] },
      });
    });

    fireEvent.click(screen.getByText('profile.save'));

    await waitFor(() => {
      expect(mocks.showMessage).toHaveBeenCalledWith('Could not save your profile. Please try again.', 'error');
    });
  });
});
