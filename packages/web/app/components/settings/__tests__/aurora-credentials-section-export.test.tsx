import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import { AURORA_BOARDS } from '@boardsesh/shared-schema';
import AuroraCredentialsSection from '../aurora-credentials-section';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('server-only', () => ({}));

const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { id: 'test-user', name: 'Test User', email: 'test@example.com' } },
  }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isAuthenticated: true, isLoading: false, error: null }),
}));

const requestAndDeliverUserDataExportMock = vi.fn();
vi.mock('@/app/lib/user-data-export-client', () => ({
  formatBoardTypeLabel: (boardType: string) => boardType.charAt(0).toUpperCase() + boardType.slice(1),
  requestAndDeliverUserDataExport: (...args: unknown[]) => requestAndDeliverUserDataExportMock(...args),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation((url: RequestInfo | URL) => {
    const href = String(url);
    if (href.includes('/api/internal/aurora-credentials/unsynced')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ counts: {} }),
      });
    }
    if (href.includes('/api/internal/aurora-credentials')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ credentials: [] }),
      });
    }
    return Promise.reject(new Error(`Unexpected fetch: ${href}`));
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('AuroraCredentialsSection export actions', () => {
  it('shows export actions beside board import controls and exports the selected board', async () => {
    requestAndDeliverUserDataExportMock.mockResolvedValue('downloaded');

    render(<AuroraCredentialsSection />);

    await screen.findByText('Kilter Board');
    await screen.findByText('Tension Board');

    const exportButtons = screen.getAllByRole('button', { name: 'Export' });
    expect(exportButtons).toHaveLength(AURORA_BOARDS.length);

    fireEvent.click(exportButtons[0]);

    await waitFor(() => {
      expect(requestAndDeliverUserDataExportMock).toHaveBeenCalledWith(
        'kilter',
        'test-token',
        expect.objectContaining({ onGenerating: expect.any(Function) }),
      );
    });

    await waitFor(() => {
      expect(mockShowMessage).toHaveBeenCalledWith('Kilter export downloaded.', 'success');
    });
  });
});
