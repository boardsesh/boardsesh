// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { IntegrationStatus } from '@boardsesh/shared-schema';

// --- Hoisted mock state, mutated per-test before render ---
const mocks = vi.hoisted(() => ({
  connectStrava: vi.fn<() => Promise<'connected' | 'error' | 'cancelled'>>(),
  showToast: vi.fn(),
  refetch: vi.fn(() => Promise.resolve()),
  autoSyncMutate: vi.fn(),
  disconnectMutate: vi.fn(),
  alert: vi.fn(),
  confirmResult: true,
  statuses: undefined as IntegrationStatus[] | undefined,
  isLoading: false,
}));

vi.mock('../../../lib/integrations', () => ({
  connectStrava: mocks.connectStrava,
}));

vi.mock('../../../lib/graphql/hooks', () => ({
  useIntegrationStatuses: () => ({ data: mocks.statuses, isLoading: mocks.isLoading, refetch: mocks.refetch }),
  useSetIntegrationAutoSync: () => ({ mutate: mocks.autoSyncMutate }),
  useDisconnectIntegration: () => ({ mutate: mocks.disconnectMutate }),
}));

type RNViewProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children }: RNViewProps) => createElement('div', {}, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
  Alert: { alert: (...args: unknown[]) => mocks.alert(...args) },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) => (opts?.name != null ? `${key}:${opts.name}` : key),
  }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#fff', secondaryLabel: '#888' },
    brandColors: { primary: '#6D28D9', error: '#C81E1E' },
  }),
}));

vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));
vi.mock('../../../providers/dialog-provider', () => ({
  useConfirm: () => () => Promise.resolve(mocks.confirmResult),
}));

type TextMockProps = { children?: ReactNode };
vi.mock('../../Text', () => ({
  Text: ({ children }: TextMockProps) => createElement('span', { 'data-text': 'true' }, children),
}));

type ButtonMockProps = { title: string; onPress?: () => void; disabled?: boolean; loading?: boolean };
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled, loading }: ButtonMockProps) =>
    createElement('button', {
      onClick: onPress,
      'data-button': title,
      'data-disabled': disabled ? 'true' : 'false',
      'data-loading': loading ? 'true' : 'false',
    }),
}));

type ListRowMockProps = { title: string; onPress?: () => void };
vi.mock('../../ListRow', () => ({
  ListRow: ({ title, onPress }: ListRowMockProps) =>
    createElement('div', { 'data-listrow': title, onClick: onPress }, title),
}));

type SwitchRowMockProps = { label: string; value?: boolean; onValueChange?: (next: boolean) => void };
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({ label, value, onValueChange }: SwitchRowMockProps) =>
    createElement('button', {
      'data-switch': label,
      'data-value': value ? 'true' : 'false',
      onClick: () => onValueChange?.(!value),
    }),
}));

vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { lg: 12 },
}));

import { StravaCard } from '../StravaCard';

const connectedStatus: IntegrationStatus = {
  provider: 'STRAVA',
  connected: true,
  externalAccountName: 'Marco',
  autoSyncEnabled: true,
  status: 'active',
};

const button = (root: HTMLElement, title: string) =>
  root.querySelector(`[data-button="${title}"]`) as HTMLButtonElement | null;

describe('StravaCard', () => {
  beforeEach(() => {
    mocks.connectStrava.mockReset();
    mocks.showToast.mockReset();
    mocks.refetch.mockClear();
    mocks.autoSyncMutate.mockReset();
    mocks.disconnectMutate.mockReset();
    mocks.alert.mockReset();
    mocks.confirmResult = true;
    mocks.statuses = undefined;
    mocks.isLoading = false;
  });

  it('renders the connect button when disconnected', () => {
    mocks.statuses = [{ provider: 'STRAVA', connected: false, autoSyncEnabled: false }];
    const { container } = render(<StravaCard />);
    expect(button(container, 'integrations.strava.connect')).not.toBeNull();
    expect(container.querySelector('[data-switch]')).toBeNull();
  });

  it('renders account name, the auto-sync switch, and a disconnect action when connected', () => {
    mocks.statuses = [connectedStatus];
    const { container } = render(<StravaCard />);
    // Account label interpolates the external account name.
    expect(container.querySelector('[data-listrow="integrations.strava.connectedAs:Marco"]')).not.toBeNull();
    expect(container.querySelector('[data-switch="integrations.strava.autoSync"]')).not.toBeNull();
    expect(button(container, 'integrations.strava.disconnect')).not.toBeNull();
    expect(button(container, 'integrations.strava.connect')).toBeNull();
  });

  it('disconnects when the confirm is accepted', async () => {
    mocks.statuses = [connectedStatus];
    mocks.confirmResult = true;
    const { container } = render(<StravaCard />);
    fireEvent.click(button(container, 'integrations.strava.disconnect')!);
    await waitFor(() => {
      expect(mocks.disconnectMutate).toHaveBeenCalledTimes(1);
    });
  });

  it('does NOT disconnect when the confirm is cancelled', async () => {
    mocks.statuses = [connectedStatus];
    mocks.confirmResult = false;
    const { container } = render(<StravaCard />);
    fireEvent.click(button(container, 'integrations.strava.disconnect')!);
    // Give the awaited confirm a tick to settle, then assert the mutation never fired.
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.disconnectMutate).not.toHaveBeenCalled();
  });

  it('shows a success toast and refetches when a connection succeeds', async () => {
    mocks.statuses = [{ provider: 'STRAVA', connected: false, autoSyncEnabled: false }];
    mocks.connectStrava.mockResolvedValue('connected');
    const { container } = render(<StravaCard />);

    fireEvent.click(button(container, 'integrations.strava.connect')!);

    await waitFor(() => {
      expect(mocks.refetch).toHaveBeenCalledTimes(1);
    });
    expect(mocks.connectStrava).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith('integrations.toast.connected', 'success');
  });
});
