import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// Mock server-only
vi.mock('server-only', () => ({}));

// Mock snackbar provider
const mockShowMessage = vi.fn();
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

// Mock streamImport
const mockStreamImport = vi.fn();
vi.mock('@/app/lib/data-sync/aurora/json-import-stream', () => ({
  streamImport: (...args: unknown[]) => mockStreamImport(...args),
}));

// Mock next-auth (needed by aurora-credentials-section imports)
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: 'test-user' } } }),
}));

import BoardImportPrompt from '../board-import-prompt';

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch = vi.fn();
  global.fetch = mockFetch as unknown as typeof fetch;
});

function mockCredentialsResponse(credentials: unknown[] = []) {
  return {
    ok: true,
    json: () => Promise.resolve({ credentials }),
  };
}

const tensionCredential = {
  boardType: 'tension',
  auroraUsername: 'testuser',
  syncStatus: 'active',
  lastSyncAt: '2026-01-01T00:00:00Z',
  syncError: null,
};

describe('BoardImportPrompt', () => {
  describe('credential fetching and display', () => {
    it('renders nothing while loading credentials', () => {
      mockFetch.mockReturnValue(new Promise(() => {})); // never resolves
      const { container } = render(<BoardImportPrompt boardType="tension" />);
      expect(container.innerHTML).toBe('');
    });

    it('renders card with Link and Import buttons when no credential exists', async () => {
      mockFetch.mockResolvedValue(mockCredentialsResponse([]));

      render(<BoardImportPrompt boardType="tension" />);

      await waitFor(() => {
        expect(screen.getByText('Tension Board')).toBeTruthy();
      });

      expect(screen.getByText('Link')).toBeTruthy();
      expect(screen.getByText('Import')).toBeTruthy();
    });

    it('renders card with Unlink button when credential exists', async () => {
      mockFetch.mockResolvedValue(mockCredentialsResponse([tensionCredential]));

      render(<BoardImportPrompt boardType="tension" />);

      await waitFor(() => {
        expect(screen.getByText('Tension Board')).toBeTruthy();
      });

      expect(screen.getByText('Unlink')).toBeTruthy();
      expect(screen.getByText('Import')).toBeTruthy();
    });

    it('shows only Import for kilter (no Link button)', async () => {
      mockFetch.mockResolvedValue(mockCredentialsResponse([]));

      render(<BoardImportPrompt boardType="kilter" />);

      await waitFor(() => {
        expect(screen.getByText('Kilter Board')).toBeTruthy();
      });

      expect(screen.getByText('Import')).toBeTruthy();
      expect(screen.queryByText('Link')).toBeNull();
    });
  });

  describe('link account modal flow', () => {
    it('opens link account dialog on button click', async () => {
      mockFetch.mockResolvedValue(mockCredentialsResponse([]));

      render(<BoardImportPrompt boardType="tension" />);

      await waitFor(() => {
        expect(screen.getByText('Link')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('Link'));

      expect(screen.getByText('Link Tension Account')).toBeTruthy();
      expect(screen.getByLabelText('Username *')).toBeTruthy();
      expect(screen.getByLabelText('Password *')).toBeTruthy();
    });

    it('submits credentials and shows success message', async () => {
      mockFetch
        .mockResolvedValueOnce(mockCredentialsResponse([]))
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce(mockCredentialsResponse([tensionCredential]));

      render(<BoardImportPrompt boardType="tension" />);

      await waitFor(() => {
        expect(screen.getByText('Link')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('Link'));

      fireEvent.change(screen.getByLabelText('Username *'), { target: { value: 'myuser' } });
      fireEvent.change(screen.getByLabelText('Password *'), { target: { value: 'mypass' } });

      // Submit the form by clicking the submit button inside the dialog
      const submitButtons = screen.getAllByText('Link Account');
      const dialogSubmit = submitButtons.find((btn) => btn.closest('form'));
      fireEvent.click(dialogSubmit!);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/internal/aurora-credentials', expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ boardType: 'tension', username: 'myuser', password: 'mypass' }),
        }));
      });

      await waitFor(() => {
        expect(mockShowMessage).toHaveBeenCalledWith('Tension account linked. Your data will show up within 12 hours.', 'success');
      });
    });

    it('shows error when link account fails', async () => {
      mockFetch
        .mockResolvedValueOnce(mockCredentialsResponse([]))
        .mockResolvedValueOnce({
          ok: false,
          json: () => Promise.resolve({ error: 'Invalid credentials' }),
        });

      render(<BoardImportPrompt boardType="tension" />);

      await waitFor(() => {
        expect(screen.getByText('Link')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('Link'));
      fireEvent.change(screen.getByLabelText('Username *'), { target: { value: 'user' } });
      fireEvent.change(screen.getByLabelText('Password *'), { target: { value: 'pass' } });

      const submitButtons = screen.getAllByText('Link Account');
      const dialogSubmit = submitButtons.find((btn) => btn.closest('form'));
      fireEvent.click(dialogSubmit!);

      await waitFor(() => {
        expect(mockShowMessage).toHaveBeenCalledWith('Invalid credentials', 'error');
      });
    });
  });

  describe('unlink account flow', () => {
    it('calls DELETE endpoint when unlink is confirmed', async () => {
      mockFetch
        .mockResolvedValueOnce(mockCredentialsResponse([tensionCredential]))
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce(mockCredentialsResponse([]));

      render(<BoardImportPrompt boardType="tension" />);

      await waitFor(() => {
        expect(screen.getByText('Unlink')).toBeTruthy();
      });

      // Click Unlink which opens the ConfirmPopover
      fireEvent.click(screen.getByText('Unlink'));

      // Confirm in the popover
      await waitFor(() => {
        expect(screen.getByText('Yes, unlink')).toBeTruthy();
      });
      fireEvent.click(screen.getByText('Yes, unlink'));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/internal/aurora-credentials', expect.objectContaining({
          method: 'DELETE',
          body: JSON.stringify({ boardType: 'tension' }),
        }));
      });

      await waitFor(() => {
        expect(mockShowMessage).toHaveBeenCalledWith('Account unlinked successfully', 'success');
      });
    });

    it('shows error when unlink fails', async () => {
      mockFetch
        .mockResolvedValueOnce(mockCredentialsResponse([tensionCredential]))
        .mockResolvedValueOnce({
          ok: false,
          json: () => Promise.resolve({ error: 'Server error' }),
        });

      render(<BoardImportPrompt boardType="tension" />);

      await waitFor(() => {
        expect(screen.getByText('Unlink')).toBeTruthy();
      });

      fireEvent.click(screen.getByText('Unlink'));

      await waitFor(() => {
        expect(screen.getByText('Yes, unlink')).toBeTruthy();
      });
      fireEvent.click(screen.getByText('Yes, unlink'));

      await waitFor(() => {
        expect(mockShowMessage).toHaveBeenCalledWith('Server error', 'error');
      });
    });
  });

  describe('JSON file validation', () => {
    it('rejects files over 10MB', async () => {
      mockFetch.mockResolvedValue(mockCredentialsResponse([]));

      render(<BoardImportPrompt boardType="kilter" />);

      await waitFor(() => {
        expect(screen.getByText('Import')).toBeTruthy();
      });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const largeFile = new File(['x'.repeat(201 * 1024 * 1024)], 'big.json', { type: 'application/json' });

      fireEvent.change(fileInput, { target: { files: [largeFile] } });

      expect(mockShowMessage).toHaveBeenCalledWith(
        'File is too large (max 200MB). Please check you selected the correct file.',
        'error',
      );
    });

    it('rejects files without user.username', async () => {
      mockFetch.mockResolvedValue(mockCredentialsResponse([]));

      render(<BoardImportPrompt boardType="kilter" />);

      await waitFor(() => {
        expect(screen.getByText('Import')).toBeTruthy();
      });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const invalidJson = JSON.stringify({ ascents: [] });
      const file = new File([invalidJson], 'export.json', { type: 'application/json' });

      fireEvent.change(fileInput, { target: { files: [file] } });

      await waitFor(() => {
        expect(mockShowMessage).toHaveBeenCalledWith(
          'Invalid file: missing user data. Please select an Aurora JSON export file.',
          'error',
        );
      });
    });

    it('warns when file layout does not match target board', async () => {
      mockFetch.mockResolvedValue(mockCredentialsResponse([]));

      render(<BoardImportPrompt boardType="tension" />);

      await waitFor(() => {
        expect(screen.getByText('Import')).toBeTruthy();
      });

      const mismatchJson = JSON.stringify({
        user: { username: 'testuser' },
        climbs: [{ name: 'Test', layout: 'Kilter Board Original' }],
        ascents: [],
        attempts: [],
        circuits: [],
      });
      const file = new File([mismatchJson], 'export.json', { type: 'application/json' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      fireEvent.change(fileInput, { target: { files: [file] } });

      await waitFor(() => {
        expect(mockShowMessage).toHaveBeenCalledWith(
          expect.stringContaining('Kilter Board Original'),
          'warning',
        );
      });
    });

    it('shows preview dialog with counts for valid file', async () => {
      mockFetch.mockResolvedValue(mockCredentialsResponse([]));

      render(<BoardImportPrompt boardType="kilter" />);

      await waitFor(() => {
        expect(screen.getByText('Import')).toBeTruthy();
      });

      const validJson = JSON.stringify({
        user: { username: 'testuser' },
        ascents: [{ climb: 'c1', angle: 40, count: 1, stars: 3, climbed_at: '2024-01-01', created_at: '2024-01-01', grade: '6a' }],
        attempts: [],
        circuits: [],
      });
      const file = new File([validJson], 'export.json', { type: 'application/json' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      fireEvent.change(fileInput, { target: { files: [file] } });

      await waitFor(() => {
        expect(screen.getByText('Import Aurora Data')).toBeTruthy();
        expect(screen.getByText('1 ascents')).toBeTruthy();
        expect(screen.getByText('0 attempts')).toBeTruthy();
        expect(screen.getByText('0 circuits')).toBeTruthy();
      });
    });
  });

  describe('import flow', () => {
    it('calls streamImport on confirm and shows success', async () => {
      mockFetch.mockResolvedValue(mockCredentialsResponse([]));
      mockStreamImport.mockImplementation(async (_board: string, _data: unknown, onEvent: (e: unknown) => void) => {
        onEvent({
          type: 'complete',
          results: {
            ascents: { imported: 5, skipped: 0, failed: 0 },
            attempts: { imported: 0, skipped: 0, failed: 0 },
            circuits: { imported: 0, skipped: 0, failed: 0 },
            climbs: { imported: 0, skipped: 0, failed: 0 },
            unresolvedClimbs: [],
          },
        });
      });

      render(<BoardImportPrompt boardType="kilter" />);

      await waitFor(() => {
        expect(screen.getByText('Import')).toBeTruthy();
      });

      // Select a valid file
      const validJson = JSON.stringify({
        user: { username: 'testuser' },
        ascents: Array.from({ length: 5 }, (_, i) => ({
          climb: `c${i}`, angle: 40, count: 1, stars: 3,
          climbed_at: '2024-01-01', created_at: '2024-01-01', grade: '6a',
        })),
        attempts: [],
        circuits: [],
      });
      const file = new File([validJson], 'export.json', { type: 'application/json' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(fileInput, { target: { files: [file] } });

      // Wait for preview dialog
      await waitFor(() => {
        expect(screen.getByText('Import Aurora Data')).toBeTruthy();
      });

      // Click Import
      fireEvent.click(screen.getAllByText('Import').find((el) => el.closest('[role="dialog"]'))!);

      await waitFor(() => {
        expect(mockStreamImport).toHaveBeenCalledWith('kilter', expect.anything(), expect.any(Function));
      });

      await waitFor(() => {
        expect(screen.getByText('Import Complete')).toBeTruthy();
        expect(mockShowMessage).toHaveBeenCalledWith('Successfully imported 5 items', 'success');
      });
    });

    it('prevents closing dialog while import is in progress', async () => {
      mockFetch.mockResolvedValue(mockCredentialsResponse([]));
      // streamImport never resolves, simulating an in-progress import
      mockStreamImport.mockImplementation(() => new Promise(() => {}));

      render(<BoardImportPrompt boardType="kilter" />);

      await waitFor(() => {
        expect(screen.getByText('Import')).toBeTruthy();
      });

      const validJson = JSON.stringify({
        user: { username: 'testuser' },
        ascents: [],
        attempts: [],
        circuits: [],
      });
      const file = new File([validJson], 'export.json', { type: 'application/json' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(fileInput, { target: { files: [file] } });

      await waitFor(() => {
        expect(screen.getByText('Import Aurora Data')).toBeTruthy();
      });

      fireEvent.click(screen.getAllByText('Import').find((el) => el.closest('[role="dialog"]'))!);

      await waitFor(() => {
        expect(screen.getByText('Importing Aurora Data...')).toBeTruthy();
      });

      // Dialog should have no Close/Cancel button during import
      expect(screen.queryByText('Close')).toBeNull();
      expect(screen.queryByText('Cancel')).toBeNull();

      // The dialog should have disableEscapeKeyDown set
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
    });

    it('shows error state when import fails', async () => {
      mockFetch.mockResolvedValue(mockCredentialsResponse([]));
      mockStreamImport.mockRejectedValue(new Error('Network error'));

      render(<BoardImportPrompt boardType="kilter" />);

      await waitFor(() => {
        expect(screen.getByText('Import')).toBeTruthy();
      });

      const validJson = JSON.stringify({
        user: { username: 'testuser' },
        ascents: [],
        attempts: [],
        circuits: [],
      });
      const file = new File([validJson], 'export.json', { type: 'application/json' });
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      fireEvent.change(fileInput, { target: { files: [file] } });

      await waitFor(() => {
        expect(screen.getByText('Import Aurora Data')).toBeTruthy();
      });

      fireEvent.click(screen.getAllByText('Import').find((el) => el.closest('[role="dialog"]'))!);

      await waitFor(() => {
        expect(screen.getByText('Import Failed')).toBeTruthy();
        expect(mockShowMessage).toHaveBeenCalledWith('Network error', 'error');
      });
    });
  });
});
