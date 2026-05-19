import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

type MockActiveSession = {
  sessionId: string;
  boardPath: string;
  sharedPlaylistEnabled: boolean;
} | null;

let mockActiveSession: MockActiveSession = {
  sessionId: 'session-123',
  boardPath: '/kilter/1/10/1,2/40/list',
  sharedPlaylistEnabled: true,
};
let mockIsLoading = false;
let mockError: Error | null = null;
const mockSetEnabled = vi.fn(async (_enabled: boolean) => {});
const mockShowMessage = vi.fn();

vi.mock('@/app/components/persistent-session', () => ({
  usePersistentSessionState: () => ({
    activeSession: mockActiveSession,
  }),
}));

vi.mock('@/app/hooks/use-set-session-shared-playlist', () => ({
  useSetSessionSharedPlaylist: () => ({
    setEnabled: mockSetEnabled,
    isLoading: mockIsLoading,
    error: mockError,
  }),
}));

vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage: mockShowMessage }),
}));

import SharedPlaylistToggle from '../shared-playlist-toggle';

function getSwitchInput(): HTMLInputElement {
  // The label is "Shared queue"; the switch input is a hidden <input type="checkbox">.
  return screen.getByLabelText('Shared queue', { selector: 'input' }) as HTMLInputElement;
}

describe('SharedPlaylistToggle', () => {
  beforeEach(() => {
    mockActiveSession = {
      sessionId: 'session-123',
      boardPath: '/kilter/1/10/1,2/40/list',
      sharedPlaylistEnabled: true,
    };
    mockIsLoading = false;
    mockError = null;
    mockSetEnabled.mockReset();
    mockSetEnabled.mockResolvedValue(undefined);
    mockShowMessage.mockReset();
  });

  it('renders the switch reflecting the current value', () => {
    mockActiveSession = { ...mockActiveSession!, sharedPlaylistEnabled: true };
    render(<SharedPlaylistToggle />);
    expect(getSwitchInput().checked).toBe(true);
  });

  it('reflects an off state when sharedPlaylistEnabled is false', () => {
    mockActiveSession = { ...mockActiveSession!, sharedPlaylistEnabled: false };
    render(<SharedPlaylistToggle />);
    expect(getSwitchInput().checked).toBe(false);
  });

  it('opens the confirmation dialog when the switch is toggled', () => {
    render(<SharedPlaylistToggle />);
    fireEvent.click(getSwitchInput());
    expect(screen.getByText('Switch queue mode?')).toBeDefined();
  });

  it('shows the disable body when switching off', () => {
    mockActiveSession = { ...mockActiveSession!, sharedPlaylistEnabled: true };
    render(<SharedPlaylistToggle />);
    fireEvent.click(getSwitchInput());
    expect(screen.getByText(/Your shared queue will stop syncing/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Switch to local' })).toBeDefined();
  });

  it('shows the enable body when switching on', () => {
    mockActiveSession = { ...mockActiveSession!, sharedPlaylistEnabled: false };
    render(<SharedPlaylistToggle />);
    fireEvent.click(getSwitchInput());
    expect(screen.getByText(/Everyone joins one shared queue/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Switch to shared' })).toBeDefined();
  });

  it('fires setEnabled when confirm is clicked', async () => {
    mockActiveSession = { ...mockActiveSession!, sharedPlaylistEnabled: true };
    render(<SharedPlaylistToggle />);
    fireEvent.click(getSwitchInput());
    fireEvent.click(screen.getByRole('button', { name: 'Switch to local' }));
    await waitFor(() => {
      expect(mockSetEnabled).toHaveBeenCalledWith(false);
    });
  });

  it('does NOT fire setEnabled when the dialog is cancelled', () => {
    render(<SharedPlaylistToggle />);
    fireEvent.click(getSwitchInput());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockSetEnabled).not.toHaveBeenCalled();
  });

  it('disables the switch while the mutation is loading', () => {
    mockIsLoading = true;
    render(<SharedPlaylistToggle />);
    expect(getSwitchInput().disabled).toBe(true);
  });

  it('surfaces a snackbar when the mutation errors', () => {
    mockError = new Error('boom');
    render(<SharedPlaylistToggle />);
    expect(mockShowMessage).toHaveBeenCalledWith("Couldn't update shared queue setting", 'error');
  });
});
