import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import GymSettingsPanel from '../gym-settings-panel';

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isAuthenticated: true, isLoading: false, error: null }),
}));

const mockRequest = vi.fn();
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

const AUTO_APPROVE_KEY = 'gym_claim_auto_approve';

/** The panel's only control. MUI's Switch renders its input with role="switch". */
const getSwitch = () => screen.getByRole('switch') as HTMLInputElement;

beforeEach(() => {
  mockRequest.mockReset();
});

describe('GymSettingsPanel', () => {
  it('reads the saved value — an unset setting shows as off', async () => {
    mockRequest.mockResolvedValueOnce({ communitySettings: [] });

    render(<GymSettingsPanel />);

    await waitFor(() => expect(getSwitch().disabled).toBe(false));
    expect(getSwitch().checked).toBe(false);
  });

  it('reflects a saved value of "1" as on', async () => {
    mockRequest.mockResolvedValueOnce({
      communitySettings: [{ id: '1', scope: 'global', scopeKey: '', key: AUTO_APPROVE_KEY, value: '1' }],
    });

    render(<GymSettingsPanel />);

    await waitFor(() => expect(getSwitch().checked).toBe(true));
  });

  it('writes the global setting when toggled on', async () => {
    mockRequest.mockResolvedValueOnce({ communitySettings: [] });
    render(<GymSettingsPanel />);
    await waitFor(() => expect(getSwitch().disabled).toBe(false));

    mockRequest.mockResolvedValueOnce({ setCommunitySettings: { id: '1', key: AUTO_APPROVE_KEY, value: '1' } });
    fireEvent.click(getSwitch());

    await waitFor(() =>
      expect(mockRequest).toHaveBeenLastCalledWith(expect.anything(), {
        input: { scope: 'global', scopeKey: '', key: AUTO_APPROVE_KEY, value: '1' },
      }),
    );
    expect(getSwitch().checked).toBe(true);
  });

  it('writes "0" when toggled back off', async () => {
    mockRequest.mockResolvedValueOnce({
      communitySettings: [{ id: '1', scope: 'global', scopeKey: '', key: AUTO_APPROVE_KEY, value: '1' }],
    });
    render(<GymSettingsPanel />);
    await waitFor(() => expect(getSwitch().checked).toBe(true));

    mockRequest.mockResolvedValueOnce({ setCommunitySettings: { id: '1', key: AUTO_APPROVE_KEY, value: '0' } });
    fireEvent.click(getSwitch());

    await waitFor(() =>
      expect(mockRequest).toHaveBeenLastCalledWith(expect.anything(), {
        input: { scope: 'global', scopeKey: '', key: AUTO_APPROVE_KEY, value: '0' },
      }),
    );
    expect(getSwitch().checked).toBe(false);
  });

  it('surfaces a load failure and leaves the switch disabled', async () => {
    mockRequest.mockRejectedValueOnce(new Error('network down'));

    render(<GymSettingsPanel />);

    await screen.findByText("Couldn't load gym settings.");
    // Never let a failed read look like "auto-approval is off" — the switch
    // stays disabled so an admin can't act on a value we never received.
    expect(getSwitch().disabled).toBe(true);
  });

  it('rolls the toggle back when the write is rejected', async () => {
    mockRequest.mockResolvedValueOnce({ communitySettings: [] });
    render(<GymSettingsPanel />);
    await waitFor(() => expect(getSwitch().disabled).toBe(false));

    // A community leader hitting the admin-only gate looks exactly like this.
    mockRequest.mockRejectedValueOnce(new Error('Admin role required for this operation'));
    fireEvent.click(getSwitch());

    // The optimistic flip must not survive a rejected write, or the admin walks
    // away believing auto-approval is on when the server never stored it.
    await waitFor(() => expect(getSwitch().checked).toBe(false));
  });
});
