import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// Mock server-only
vi.mock('server-only', () => ({}));

// Mock next-auth/react
const mockUpdate = vi.fn();
let mockSessionData: { data: Record<string, unknown> | null; status: string; update: typeof mockUpdate };

vi.mock('next-auth/react', () => ({
  useSession: () => mockSessionData,
}));

// Mock party profile context
const mockRefreshProfile = vi.fn();
vi.mock('@/app/components/party-manager/party-profile-context', () => ({
  usePartyProfile: () => ({ refreshProfile: mockRefreshProfile }),
}));

import UsernameSetupDialog from '../username-setup-dialog';

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch = vi.fn();
  global.fetch = mockFetch as unknown as typeof fetch;
  mockUpdate.mockResolvedValue(undefined);
  mockRefreshProfile.mockResolvedValue(undefined);
});

function setSession(overrides: { name?: string | null; status?: string }) {
  const status = overrides.status ?? 'authenticated';
  mockSessionData = {
    data:
      status === 'unauthenticated'
        ? null
        : {
            user: {
              id: 'user-1',
              email: 'test@example.com',
              name: overrides.name ?? null,
            },
          },
    status,
    update: mockUpdate,
  };
}

describe('UsernameSetupDialog', () => {
  describe('visibility', () => {
    it('does not render when user has a name', () => {
      setSession({ name: 'Test User' });
      render(<UsernameSetupDialog />);
      expect(screen.queryByText('Pick a name')).toBeNull();
    });

    it('does not render when user is not authenticated', () => {
      setSession({ status: 'unauthenticated' });
      render(<UsernameSetupDialog />);
      expect(screen.queryByText('Pick a name')).toBeNull();
    });

    it('does not render while session is loading', () => {
      setSession({ status: 'loading' });
      render(<UsernameSetupDialog />);
      expect(screen.queryByText('Pick a name')).toBeNull();
    });

    it('renders when user is authenticated but has no name (null)', () => {
      setSession({ name: null });
      render(<UsernameSetupDialog />);
      expect(screen.getByText('Pick a name')).toBeTruthy();
      expect(screen.getByText('This is how other crushers will see you.')).toBeTruthy();
    });

    it('renders when user name is empty string', () => {
      setSession({ name: '' });
      render(<UsernameSetupDialog />);
      expect(screen.getByText('Pick a name')).toBeTruthy();
    });
  });

  describe('form validation', () => {
    beforeEach(() => {
      setSession({ name: null });
    });

    it('save button is disabled when input is empty', () => {
      render(<UsernameSetupDialog />);
      const saveButton = screen.getByRole('button', { name: /save/i });
      expect(saveButton.hasAttribute('disabled')).toBe(true);
    });

    it('save button is disabled when input is only whitespace', () => {
      render(<UsernameSetupDialog />);
      const input = screen.getByLabelText('Display name');
      fireEvent.change(input, { target: { value: '   ' } });
      const saveButton = screen.getByRole('button', { name: /save/i });
      expect(saveButton.hasAttribute('disabled')).toBe(true);
    });

    it('save button is enabled when input has non-whitespace text', () => {
      render(<UsernameSetupDialog />);
      const input = screen.getByLabelText('Display name');
      fireEvent.change(input, { target: { value: 'Gabrielle' } });
      const saveButton = screen.getByRole('button', { name: /save/i });
      expect(saveButton.hasAttribute('disabled')).toBe(false);
    });

    it('enforces max length of 100 characters', () => {
      render(<UsernameSetupDialog />);
      const input = screen.getByLabelText('Display name');
      expect(input.getAttribute('maxlength')).toBe('100');
    });
  });

  describe('save flow', () => {
    beforeEach(() => {
      setSession({ name: null });
    });

    it('calls profile API on save with trimmed display name', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      render(<UsernameSetupDialog />);
      const input = screen.getByLabelText('Display name');
      fireEvent.change(input, { target: { value: '  Gabrielle  ' } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/internal/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: 'Gabrielle' }),
        });
      });
    });

    it('calls session update after successful save', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      render(<UsernameSetupDialog />);
      const input = screen.getByLabelText('Display name');
      fireEvent.change(input, { target: { value: 'Gabrielle' } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalled();
      });
    });

    it('calls refreshProfile after successful save', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      render(<UsernameSetupDialog />);
      const input = screen.getByLabelText('Display name');
      fireEvent.change(input, { target: { value: 'Gabrielle' } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockRefreshProfile).toHaveBeenCalled();
      });
    });

    it('shows error state on API failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Display name must be less than 100 characters' }),
      });

      render(<UsernameSetupDialog />);
      const input = screen.getByLabelText('Display name');
      fireEvent.change(input, { target: { value: 'Gabrielle' } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByText('Display name must be less than 100 characters')).toBeTruthy();
      });
    });

    it('shows generic error on network failure', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      render(<UsernameSetupDialog />);
      const input = screen.getByLabelText('Display name');
      fireEvent.change(input, { target: { value: 'Gabrielle' } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeTruthy();
      });
    });

    it('re-enables save button after error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: 'Server error' }),
      });

      render(<UsernameSetupDialog />);
      const input = screen.getByLabelText('Display name');
      fireEvent.change(input, { target: { value: 'Gabrielle' } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        const saveButton = screen.getByRole('button', { name: /save/i });
        expect(saveButton.hasAttribute('disabled')).toBe(false);
      });
    });

    it('supports Enter key to submit', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      render(<UsernameSetupDialog />);
      const input = screen.getByLabelText('Display name');
      fireEvent.change(input, { target: { value: 'Gabrielle' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalled();
      });
    });
  });

  describe('dialog behavior', () => {
    it('does not have a close button', () => {
      setSession({ name: null });
      render(<UsernameSetupDialog />);
      // MUI close buttons typically have aria-label "close"
      expect(screen.queryByLabelText('close')).toBeNull();
    });
  });
});
