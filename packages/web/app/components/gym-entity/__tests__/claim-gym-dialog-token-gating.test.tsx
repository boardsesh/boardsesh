/**
 * Submitting before the ws auth token has arrived.
 *
 * `submit()` opens with `if (!token) return`, and `useWsAuthToken`'s query key
 * includes the session status — so the token is briefly null right after a
 * sign-in. With the buttons left enabled that first tap did nothing at all: no
 * request, no error, no spinner. Signing in through the auth modal and landing
 * straight on this dialog makes that the common path, not an edge case.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

const authTokenState = vi.hoisted(() => ({
  token: null as string | null,
  isLoading: false,
  error: null as string | null,
}));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({
    token: authTokenState.token,
    isAuthenticated: authTokenState.token !== null,
    isLoading: authTokenState.isLoading,
    error: authTokenState.error,
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: vi.fn() }),
}));

vi.mock('@/app/lib/gym-funnel-analytics', () => ({ trackGymFunnelEvent: vi.fn() }));

const ClaimGymDialog = (await import('../claim-gym-dialog')).default;

// The web test setup ships no jest-dom, so `toBeDisabled` throws "Invalid Chai
// property" — read the DOM property instead.
const isDisabled = (label: string) => (screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled;

const renderDialog = (website: string | null) =>
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ClaimGymDialog
        gymUuid="gym-uuid-1"
        gymName="Bonsist"
        website={website}
        canClaimByDomain={website !== null}
        open
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );

beforeEach(() => {
  authTokenState.token = null;
  authTokenState.isLoading = false;
  authTokenState.error = null;
});

const TOKEN_FAILURE_COPY = "We couldn't confirm you're logged in. Reload the page and try again.";

describe('ClaimGymDialog — submit gating on the ws auth token', () => {
  it('disables the admin-review submit while the token is still null', () => {
    renderDialog(null);

    expect(isDisabled('Request review')).toBe(true);
  });

  it('enables the admin-review submit once the token lands', () => {
    authTokenState.token = 'test-token';

    renderDialog(null);

    expect(isDisabled('Request review')).toBe(false);
  });

  it('explains the dead button once the token request has given up', () => {
    // useWsAuthToken retries three times and then stops. Without this the
    // button is permanently disabled with nothing on screen to explain it —
    // strictly worse than the silent no-op the disabled state replaced.
    authTokenState.error = 'Failed to fetch auth token: 500';

    renderDialog(null);

    expect(screen.getByText(TOKEN_FAILURE_COPY)).toBeTruthy();
    expect(isDisabled('Request review')).toBe(true);
  });

  it('stays quiet while the token is still in flight', () => {
    authTokenState.isLoading = true;

    renderDialog(null);

    expect(screen.queryByText(TOKEN_FAILURE_COPY)).toBeNull();
    expect(isDisabled('Request review')).toBe(true);
  });

  it('shows no failure copy once the token lands', () => {
    authTokenState.token = 'test-token';

    renderDialog(null);

    expect(screen.queryByText(TOKEN_FAILURE_COPY)).toBeNull();
  });

  it('disables the domain submit with a null token even when the email is filled in', () => {
    renderDialog('https://bonsist.example');

    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'owner@bonsist.example' } });

    expect(isDisabled('Send verification email')).toBe(true);
  });
});
