import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '@/app/test-utils/test-providers';
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

/** The panel reads and writes through React Query, so it needs a client. */
const renderPanel = () =>
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <GymSettingsPanel />
    </QueryClientProvider>,
  );

beforeEach(() => {
  mockRequest.mockReset();
});

describe('GymSettingsPanel', () => {
  it('reads the saved value — an unset setting shows as off', async () => {
    mockRequest.mockResolvedValueOnce({ communitySettings: [] });

    renderPanel();

    await waitFor(() => expect(getSwitch().disabled).toBe(false));
    expect(getSwitch().checked).toBe(false);
  });

  it('reflects a saved value of "1" as on', async () => {
    mockRequest.mockResolvedValueOnce({
      communitySettings: [{ id: '1', scope: 'global', scopeKey: '', key: AUTO_APPROVE_KEY, value: '1' }],
    });

    renderPanel();

    await waitFor(() => expect(getSwitch().checked).toBe(true));
  });

  it('writes the global setting when toggled on', async () => {
    mockRequest.mockResolvedValueOnce({ communitySettings: [] });
    renderPanel();
    await waitFor(() => expect(getSwitch().disabled).toBe(false));

    mockRequest.mockResolvedValueOnce({ setCommunitySettings: { id: '1', key: AUTO_APPROVE_KEY, value: '1' } });
    fireEvent.click(getSwitch());

    // onSettled refetches, so the write is not necessarily the last call.
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith(expect.anything(), {
        input: { scope: 'global', scopeKey: '', key: AUTO_APPROVE_KEY, value: '1' },
      }),
    );
    expect(getSwitch().checked).toBe(true);
  });

  it('writes "0" when toggled back off', async () => {
    mockRequest.mockResolvedValueOnce({
      communitySettings: [{ id: '1', scope: 'global', scopeKey: '', key: AUTO_APPROVE_KEY, value: '1' }],
    });
    renderPanel();
    await waitFor(() => expect(getSwitch().checked).toBe(true));

    mockRequest.mockResolvedValueOnce({ setCommunitySettings: { id: '1', key: AUTO_APPROVE_KEY, value: '0' } });
    fireEvent.click(getSwitch());

    // onSettled refetches, so the write is not necessarily the last call.
    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith(expect.anything(), {
        input: { scope: 'global', scopeKey: '', key: AUTO_APPROVE_KEY, value: '0' },
      }),
    );
    expect(getSwitch().checked).toBe(false);
  });

  it('surfaces a load failure and leaves the switch disabled', async () => {
    mockRequest.mockRejectedValueOnce(new Error('network down'));

    renderPanel();

    await screen.findByText("Couldn't load gym settings.");
    // Never let a failed read look like "auto-approval is off" — the switch
    // stays disabled so an admin can't act on a value we never received.
    expect(getSwitch().disabled).toBe(true);
  });

  it('rolls the toggle back when the write is rejected', async () => {
    mockRequest.mockResolvedValueOnce({ communitySettings: [] });
    renderPanel();
    await waitFor(() => expect(getSwitch().disabled).toBe(false));

    // A community leader hitting the admin-only gate looks exactly like this.
    mockRequest.mockRejectedValueOnce(new Error('Admin role required for this operation'));
    fireEvent.click(getSwitch());

    // The optimistic flip must not survive a rejected write, or the admin walks
    // away believing auto-approval is on when the server never stored it.
    await waitFor(() => expect(getSwitch().checked).toBe(false));
  });
});

describe('GymSettingsPanel: the daily limit', () => {
  const capField = () => screen.getByRole('spinbutton', { name: 'Daily limit' }) as HTMLInputElement;
  const saveButton = () => screen.getByRole('button', { name: 'Save limit' }) as HTMLButtonElement;

  it("shows the backend's default of 10 while the setting is unset", async () => {
    mockRequest.mockResolvedValueOnce({ communitySettings: [] });
    renderPanel();
    await waitFor(() => expect(capField().disabled).toBe(false));
    expect(capField().value).toBe('10');
    expect(saveButton().disabled).toBe(true);
  });

  it('saves a new whole number as the setting', async () => {
    mockRequest
      .mockResolvedValueOnce({
        communitySettings: [
          { id: '2', scope: 'global', scopeKey: '', key: 'gym_claim_auto_approve_daily_cap', value: '4' },
        ],
      })
      .mockResolvedValue({ communitySettings: [] });
    renderPanel();
    await waitFor(() => expect(capField().value).toBe('4'));

    fireEvent.change(capField(), { target: { value: '2' } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith(expect.anything(), {
        input: { scope: 'global', scopeKey: '', key: 'gym_claim_auto_approve_daily_cap', value: '2' },
      }),
    );
  });

  const storedCap = (value: string) => ({
    communitySettings: [{ id: '2', scope: 'global', scopeKey: '', key: 'gym_claim_auto_approve_daily_cap', value }],
  });

  it('shows a stored cap above 1000 as the backend applies it, without calling it invalid', async () => {
    mockRequest.mockResolvedValueOnce(storedCap('2000'));
    renderPanel();
    await waitFor(() => expect(capField().value).toBe('2000'));
    expect(screen.queryByText('Enter a whole number from 0 to 1000.')).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it('shows a negative stored cap as 0, the way the backend reads it', async () => {
    mockRequest.mockResolvedValueOnce(storedCap('-3'));
    renderPanel();
    await waitFor(() => expect(capField().value).toBe('0'));
  });

  it('lets the admin save the default over a stored value the backend reads as the default', async () => {
    mockRequest.mockResolvedValueOnce(storedCap('ten')).mockResolvedValue({ communitySettings: [] });
    renderPanel();
    await waitFor(() => expect(capField().disabled).toBe(false));
    expect(capField().value).toBe('10');
    expect(saveButton().disabled).toBe(true);

    // Retyped: cleared, then 10, as an admin does over a field already showing 10.
    fireEvent.change(capField(), { target: { value: '' } });
    fireEvent.change(capField(), { target: { value: '10' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith(expect.anything(), {
        input: { scope: 'global', scopeKey: '', key: 'gym_claim_auto_approve_daily_cap', value: '10' },
      }),
    );
  });

  it('refuses anything but a whole number from 0 to 1000', async () => {
    mockRequest.mockResolvedValueOnce({ communitySettings: [] });
    renderPanel();
    await waitFor(() => expect(capField().disabled).toBe(false));

    fireEvent.change(capField(), { target: { value: '1001' } });

    expect(screen.getByText('Enter a whole number from 0 to 1000.')).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });
});
