// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';

// Mock server-only
vi.mock('server-only', () => ({}));

// Mock next-auth/react
const mockSignIn = vi.fn();
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => mockSignIn(...args),
}));

// Mock useSearchParams
let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

// Mock snackbar
const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

import ConnectedAccountsSection from '../connected-accounts-section';

let mockFetch: ReturnType<typeof vi.fn>;

const providersConfigAll = { google: true, apple: true, facebook: true };
const providersConfigNone = { google: false, apple: false, facebook: false };

function mockFetchResponses(
  providersConfig: Record<string, boolean> = providersConfigAll,
  linkAccountResponse?: { ok: boolean; json: () => Promise<unknown> },
) {
  mockFetch = vi.fn((url: string, options?: RequestInit) => {
    if (url === '/api/auth/providers-config') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(providersConfig),
      });
    }
    if (url === '/api/internal/link-account') {
      if (linkAccountResponse) {
        return Promise.resolve(linkAccountResponse);
      }
      if (options?.method === 'POST') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      if (options?.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  }) as unknown as ReturnType<typeof vi.fn>;
  global.fetch = mockFetch as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSearchParams = new URLSearchParams();
  // Mock window.history.replaceState
  vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
});

describe('ConnectedAccountsSection', () => {
  it('shows skeleton while loading providers config', () => {
    // Use a fetch that never resolves to keep loading state
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    render(
      <ConnectedAccountsSection
        linkedProviders={[]}
        hasPassword={false}
        onProvidersChanged={vi.fn()}
      />,
    );

    expect(screen.getByText('Connected Accounts')).toBeTruthy();
    // Skeleton is rendered during loading
    expect(document.querySelector('.MuiSkeleton-root')).toBeTruthy();
  });

  it('renders available providers after loading', async () => {
    mockFetchResponses(providersConfigAll);

    render(
      <ConnectedAccountsSection
        linkedProviders={[]}
        hasPassword={false}
        onProvidersChanged={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Google')).toBeTruthy();
      expect(screen.getByText('Apple')).toBeTruthy();
      expect(screen.getByText('Facebook')).toBeTruthy();
    });
  });

  it('shows Connect button for unlinked providers and Disconnect for linked ones', async () => {
    mockFetchResponses(providersConfigAll);

    render(
      <ConnectedAccountsSection
        linkedProviders={['google']}
        hasPassword={true}
        onProvidersChanged={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Google')).toBeTruthy();
    });

    // Google is linked - should have Disconnect
    const disconnectButtons = screen.getAllByText('Disconnect');
    expect(disconnectButtons.length).toBe(1);

    // Apple and Facebook are not linked - should have Connect
    const connectButtons = screen.getAllByText('Connect');
    expect(connectButtons.length).toBe(2);
  });

  it('disables disconnect button when it is the only auth method (no password, 1 provider)', async () => {
    mockFetchResponses(providersConfigAll);

    render(
      <ConnectedAccountsSection
        linkedProviders={['google']}
        hasPassword={false}
        onProvidersChanged={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Google')).toBeTruthy();
    });

    const disconnectButton = screen.getByText('Disconnect').closest('button');
    expect(disconnectButton?.hasAttribute('disabled')).toBe(true);
  });

  it('calls POST /api/internal/link-account and signIn when connecting', async () => {
    mockFetchResponses(providersConfigAll);
    mockSignIn.mockResolvedValue(undefined);

    render(
      <ConnectedAccountsSection
        linkedProviders={[]}
        hasPassword={false}
        onProvidersChanged={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Google')).toBeTruthy();
    });

    // Click the first Connect button (Google)
    const connectButtons = screen.getAllByText('Connect');
    fireEvent.click(connectButtons[0]);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/internal/link-account', {
        method: 'POST',
      });
    });

    await waitFor(() => {
      expect(mockSignIn).toHaveBeenCalledWith('google', { callbackUrl: '/settings' });
    });
  });

  it('calls DELETE /api/internal/link-account when disconnecting', async () => {
    mockFetchResponses(providersConfigAll);

    const onProvidersChanged = vi.fn();

    render(
      <ConnectedAccountsSection
        linkedProviders={['google', 'apple']}
        hasPassword={false}
        onProvidersChanged={onProvidersChanged}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Google')).toBeTruthy();
    });

    // Click the first Disconnect button
    const disconnectButtons = screen.getAllByText('Disconnect');
    fireEvent.click(disconnectButtons[0]);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/internal/link-account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'google' }),
      });
    });

    await waitFor(() => {
      expect(mockShowMessage).toHaveBeenCalledWith('Google disconnected', 'success');
      expect(onProvidersChanged).toHaveBeenCalled();
    });
  });

  it('shows success snackbar when ?linked=google is in URL', async () => {
    mockSearchParams = new URLSearchParams('linked=google');
    mockFetchResponses(providersConfigAll);

    render(
      <ConnectedAccountsSection
        linkedProviders={['google']}
        hasPassword={true}
        onProvidersChanged={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(mockShowMessage).toHaveBeenCalledWith('Google connected to your account', 'success');
    });

    expect(window.history.replaceState).toHaveBeenCalled();
  });

  it('shows error snackbar when ?link_error=email_mismatch is in URL', async () => {
    mockSearchParams = new URLSearchParams('link_error=email_mismatch');
    mockFetchResponses(providersConfigAll);

    render(
      <ConnectedAccountsSection
        linkedProviders={[]}
        hasPassword={false}
        onProvidersChanged={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(mockShowMessage).toHaveBeenCalledWith(
        "The email on that account doesn't match yours. Use the same email to connect.",
        'error',
      );
    });

    expect(window.history.replaceState).toHaveBeenCalled();
  });

  it('shows info alert when 1 provider linked and no password', async () => {
    mockFetchResponses(providersConfigAll);

    render(
      <ConnectedAccountsSection
        linkedProviders={['google']}
        hasPassword={false}
        onProvidersChanged={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText('Set a password below so you can disconnect this provider later.'),
      ).toBeTruthy();
    });
  });

  it('returns null when no providers are configured', async () => {
    mockFetchResponses(providersConfigNone);

    const { container } = render(
      <ConnectedAccountsSection
        linkedProviders={[]}
        hasPassword={false}
        onProvidersChanged={vi.fn()}
      />,
    );

    // Wait for loading to finish
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/auth/providers-config');
    });

    // After loading with no providers, component returns null
    await waitFor(() => {
      expect(container.innerHTML).toBe('');
    });
  });
});
