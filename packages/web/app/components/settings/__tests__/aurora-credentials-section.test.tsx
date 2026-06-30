import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

// --- Hoisted mocks ---
const mockSaveKilterViaPassword = vi.fn();
const mockSaveAuroraCredential = vi.fn();
const mockGetAuroraCredentials = vi.fn();
const mockGetAuroraUnsyncedCounts = vi.fn();
const mockShowMessage = vi.fn();
let mockFeatureFlags: Record<string, boolean | undefined> = {};

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('server-only', () => ({}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isLoading: false, isAuthenticated: true, error: null }),
}));

vi.mock('@/app/lib/aurora-credentials/client', () => ({
  getAuroraCredentials: (...args: unknown[]) => mockGetAuroraCredentials(...args),
  getAuroraUnsyncedCounts: (...args: unknown[]) => mockGetAuroraUnsyncedCounts(...args),
  saveAuroraCredential: (...args: unknown[]) => mockSaveAuroraCredential(...args),
  saveKilterCredentialViaPassword: (...args: unknown[]) => mockSaveKilterViaPassword(...args),
  deleteAuroraCredential: vi.fn(),
  finalizeKilterCredential: vi.fn(),
  resolveAuroraBackendTransport: (token: string | null) => token,
  streamImport: vi.fn(),
}));

vi.mock('@/app/components/providers/feature-flags-provider', () => ({
  useFeatureFlag: (key: string) => mockFeatureFlags[key],
  useFeatureFlags: () => mockFeatureFlags,
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'test-user', name: 'Test User', email: 'test@test.com' } } }),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock('@/app/lib/data-sync/aurora/json-import-stream', () => ({
  streamImport: vi.fn(),
}));

vi.mock('@/app/lib/data-sync/aurora/parse-aurora-export', () => ({
  parseAuroraExport: vi.fn(),
}));

import AuroraCredentialsSection from '../aurora-credentials-section';

describe('AuroraCredentialsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFeatureFlags = {};
    mockGetAuroraCredentials.mockResolvedValue({ credentials: [] });
    mockGetAuroraUnsyncedCounts.mockResolvedValue({});
    mockSaveKilterViaPassword.mockResolvedValue({ success: true });
    mockSaveAuroraCredential.mockResolvedValue({ success: true });
  });

  describe('credential save dispatch', () => {
    it('calls saveKilterCredentialViaPassword when submitting kilter sign-in', async () => {
      mockFeatureFlags = { 'kilter-oauth-linking': true };

      render(<AuroraCredentialsSection />);

      await waitFor(() => {
        expect(screen.getByText('Sign in to Kilter')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('Sign in to Kilter'));

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Enter your username')).toBeTruthy();
      });

      fireEvent.change(screen.getByPlaceholderText('Enter your username'), {
        target: { value: 'kilteruser' },
      });
      fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
        target: { value: 'kilterpass' },
      });

      fireEvent.click(screen.getByRole('button', { name: 'Link Account' }));

      await waitFor(() => {
        expect(mockSaveKilterViaPassword).toHaveBeenCalledWith('test-token', {
          username: 'kilteruser',
          password: 'kilterpass',
        });
        expect(mockSaveAuroraCredential).not.toHaveBeenCalled();
      });
    });

    it('hides the Kilter (new) sign-in card when the flag is off and nothing is linked', async () => {
      render(<AuroraCredentialsSection />);

      // Wait for the non-kilter board cards to render so the absence check runs
      // after load, not before.
      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: 'Link' }).length).toBeGreaterThan(0);
      });

      expect(screen.queryByText('Sign in to Kilter')).toBeNull();
    });

    it('keeps the Kilter (new) card when the flag is off but an account is already linked', async () => {
      // The core UX promise: a linked Kilter account stays manageable even after
      // the PostHog flag is switched off (showKilterNew = flag || hasKilterCredential).
      mockGetAuroraCredentials.mockResolvedValue({
        credentials: [
          {
            boardType: 'kilter',
            auroraUsername: 'kilteruser',
            syncStatus: 'synced',
            lastSyncAt: null,
            syncError: null,
          },
        ],
      });

      render(<AuroraCredentialsSection />);

      await waitFor(() => {
        expect(screen.getByText('Kilter (new)')).toBeTruthy();
      });
    });

    it('calls saveAuroraCredential (not saveKilterCredentialViaPassword) when linking a non-kilter board', async () => {
      render(<AuroraCredentialsSection />);

      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: 'Link' }).length).toBeGreaterThan(0);
      });

      // Click the first "Link" button — belongs to the first non-kilter aurora board (tension)
      fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Enter your username')).toBeTruthy();
      });

      fireEvent.change(screen.getByPlaceholderText('Enter your username'), {
        target: { value: 'aurorauser' },
      });
      fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
        target: { value: 'aurorapass' },
      });

      fireEvent.click(screen.getByRole('button', { name: 'Link Account' }));

      await waitFor(() => {
        expect(mockSaveAuroraCredential).toHaveBeenCalledWith(
          'test-token',
          expect.objectContaining({ username: 'aurorauser', password: 'aurorapass' }),
        );
        expect(mockSaveKilterViaPassword).not.toHaveBeenCalled();
      });
    });

    it('shows Reconnect before Unlink when a credential is expired', async () => {
      mockGetAuroraCredentials.mockResolvedValue({
        credentials: [
          {
            boardType: 'tension',
            auroraUsername: 'tensionuser',
            syncStatus: 'expired',
            lastSyncAt: null,
            syncError: null,
          },
        ],
      });

      render(<AuroraCredentialsSection />);

      await waitFor(() => {
        expect(screen.getByText('Reconnect')).toBeTruthy();
        expect(screen.getByText('Unlink')).toBeTruthy();
      });

      const buttons = screen.getAllByRole('button');
      const reconnectIdx = buttons.findIndex((b) => b.textContent?.includes('Reconnect'));
      const unlinkIdx = buttons.findIndex((b) => b.textContent?.includes('Unlink'));
      expect(reconnectIdx).toBeLessThan(unlinkIdx);
    });
  });
});
