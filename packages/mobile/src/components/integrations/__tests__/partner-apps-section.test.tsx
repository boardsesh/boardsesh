// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ConnectedApps } from '@boardsesh/shared-schema';

type MutateCallbacks = { onSuccess?: () => void; onError?: () => void; onSettled?: () => void };

const mocks = vi.hoisted(() => ({
  isAuthenticated: true,
  data: undefined as ConnectedApps | undefined,
  isError: false,
  refetch: vi.fn(),
  mutate: vi.fn<(variables: { connectionId: string }, callbacks: MutateCallbacks) => void>(),
  showToast: vi.fn(),
  confirmResult: true,
  confirm: vi.fn((_options: unknown) => Promise.resolve(mocks.confirmResult)),
  push: vi.fn(),
  back: vi.fn(),
  params: {} as { id?: string },
  title: undefined as string | undefined,
}));

vi.mock('../../../lib/graphql/hooks/use-connected-apps', () => ({
  useMyConnectedApps: () => ({ data: mocks.data, isError: mocks.isError, refetch: mocks.refetch }),
  useDisconnectApp: () => ({ mutate: mocks.mutate }),
}));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({ isAuthenticated: mocks.isAuthenticated }),
}));
vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));
vi.mock('../../../providers/dialog-provider', () => ({
  useConfirm: () => mocks.confirm,
}));
vi.mock('../../../lib/routing/scoped-navigation', () => ({ scopedRouter: { push: mocks.push } }));
vi.mock('expo-router', () => ({
  Stack: {
    Screen: ({ options }: { options?: { title?: string } }) => {
      mocks.title = options?.title;
      return null;
    },
  },
  useLocalSearchParams: () => mocks.params,
  useRouter: () => ({ back: mocks.back, canGoBack: () => true }),
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ scrollBottomPadding: 0 }),
}));
vi.mock('../../../lib/clock', () => ({ nowMs: () => Date.parse('2026-11-10T12:00:00Z') }));
vi.mock('../../../lib/format-relative-time', () => ({ formatRelativeTime: (iso: string) => `ago(${iso})` }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
    i18n: { language: 'en-US' },
  }),
}));

type RNViewProps = { children?: ReactNode; testID?: string };
vi.mock('react-native', () => ({
  View: ({ children, testID }: RNViewProps) => createElement('div', { 'data-testid': testID }, children),
  ScrollView: ({ children, testID }: RNViewProps) => createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      groupedBackground: '#eee',
      secondaryGroupedBackground: '#fff',
      tertiaryGroupedBackground: '#ddd',
      secondaryLabel: '#888',
    },
    brandColors: { primary: '#6D28D9', warning: '#B45309' },
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-text': 'true' }, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));
vi.mock('../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h2', {}, title),
}));
type ListRowMockProps = { title: string; subtitle?: string; onPress?: () => void; testID?: string };
vi.mock('../../ListRow', () => ({
  ListRow: ({ title, subtitle, onPress, testID }: ListRowMockProps) =>
    createElement('button', { onClick: onPress, 'data-testid': testID }, `${title}|${subtitle ?? ''}`),
}));
type ButtonMockProps = { title: string; accessibilityLabel?: string; onPress?: () => void; loading?: boolean };
vi.mock('../../Button', () => ({
  Button: ({ title, accessibilityLabel, onPress, loading }: ButtonMockProps) =>
    createElement(
      'button',
      { onClick: onPress, 'aria-label': accessibilityLabel, 'data-loading': loading ? 'true' : 'false' },
      title,
    ),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
  borderRadius: { lg: 12, md: 8 },
}));

import { PartnerAppsSection } from '../PartnerAppsSection';
import { ConnectedAppDetailScreen } from '../ConnectedAppDetailScreen';

const TWO_APPS: ConnectedApps = {
  partnerAppsEnabled: true,
  apps: [
    {
      connectionId: 'connection-sequence',
      name: 'Sequence',
      publisherName: null,
      scopes: ['profile:read', 'logbook:read', 'offline_access'],
      connectedAt: '2026-10-12T08:00:00.000Z',
      lastUsedAt: '2026-11-10T09:00:00.000Z',
      suspended: false,
    },
    {
      connectionId: 'connection-divepeaks',
      name: 'DivePeaks',
      publisherName: null,
      scopes: ['logbook:read'],
      connectedAt: '2026-09-01T08:00:00.000Z',
      lastUsedAt: null,
      suspended: true,
    },
  ],
};

const SEQUENCE_DISCONNECT = 'settings:integrations.partnerApps.disconnectA11y {"app":"Sequence"}';

beforeEach(() => {
  mocks.isAuthenticated = true;
  mocks.data = undefined;
  mocks.isError = false;
  mocks.refetch.mockReset();
  mocks.mutate.mockReset();
  mocks.showToast.mockReset();
  mocks.confirm.mockClear();
  mocks.confirmResult = true;
  mocks.push.mockReset();
  mocks.back.mockReset();
  mocks.params = {};
  mocks.title = undefined;
});

describe('PartnerAppsSection', () => {
  it('draws nothing before the list arrives, or signed out', () => {
    expect(render(<PartnerAppsSection />).container.innerHTML).toBe('');
    mocks.isAuthenticated = false;
    mocks.data = TWO_APPS;
    expect(render(<PartnerAppsSection />).container.innerHTML).toBe('');
  });

  it('draws nothing while partner apps are off and nothing is connected', () => {
    mocks.data = { apps: [], partnerAppsEnabled: false };
    expect(render(<PartnerAppsSection />).container.innerHTML).toBe('');
  });

  it('says nothing is connected once partner apps are on', () => {
    mocks.data = { apps: [], partnerAppsEnabled: true };
    const { container } = render(<PartnerAppsSection />);
    expect(container.textContent).toContain('settings:integrations.partnerApps.title');
    expect(container.textContent).toContain('settings:integrations.partnerApps.empty');
  });

  it('lists one compact row per app, and a row opens that app', () => {
    mocks.data = TWO_APPS;
    const { getByTestId, container } = render(<PartnerAppsSection />);
    expect(getByTestId('partner-app-connection-sequence').textContent).toBe(
      'Sequence|settings:integrations.partnerApps.lastUsed {"time":"ago(2026-11-10T09:00:00.000Z)"}',
    );
    expect(getByTestId('partner-app-connection-divepeaks').textContent).toBe(
      'DivePeaks|settings:integrations.partnerApps.suspendedShort',
    );
    // What an app can see lives one tap in.
    expect(container.textContent).not.toContain('settings:integrations.partnerApps.scopes.logbookRead');
    fireEvent.click(getByTestId('partner-app-connection-divepeaks'));
    expect(mocks.push).toHaveBeenCalledWith({
      pathname: '/settings/connected-app',
      params: { id: 'connection-divepeaks' },
    });
  });
});

describe('ConnectedAppDetailScreen', () => {
  it('shows what the app can see, the unlisted-climbs line, and when it connected and was used', () => {
    mocks.data = TWO_APPS;
    mocks.params = { id: 'connection-sequence' };
    const { getByTestId } = render(<ConnectedAppDetailScreen />);
    const detail = getByTestId('connected-app-detail').textContent ?? '';
    expect(mocks.title).toBe('Sequence');
    expect(detail).toContain('settings:integrations.partnerApps.scopesHeading {"app":"Sequence"}');
    expect(detail).toContain('settings:integrations.partnerApps.scopes.logbookRead');
    expect(detail).toContain('settings:integrations.partnerApps.scopes.logbookUnlisted');
    expect(detail).toContain('settings:integrations.partnerApps.connected');
    expect(detail).toContain('settings:integrations.partnerApps.lastUsed');
    expect(detail).toContain('settings:integrations.partnerApps.footer');
  });

  it('explains a suspended app', () => {
    mocks.data = TWO_APPS;
    mocks.params = { id: 'connection-divepeaks' };
    const { getByTestId } = render(<ConnectedAppDetailScreen />);
    expect(getByTestId('connected-app-detail').textContent).toContain('settings:integrations.partnerApps.suspended');
  });

  it('spins while the first load runs, then offers a retry if it failed', () => {
    mocks.params = { id: 'connection-sequence' };
    const loading = render(<ConnectedAppDetailScreen />);
    expect(loading.container.querySelector('[data-spinner]')).not.toBeNull();
    loading.unmount();

    mocks.isError = true;
    const { container, getByText } = render(<ConnectedAppDetailScreen />);
    expect(container.querySelector('[data-spinner]')).toBeNull();
    expect(container.textContent).toContain('settings:integrations.partnerApps.loadFailed');
    fireEvent.click(getByText('settings:integrations.partnerApps.retry'));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it('says so when the app is no longer connected', () => {
    mocks.data = TWO_APPS;
    mocks.params = { id: 'connection-gone' };
    const { container } = render(<ConnectedAppDetailScreen />);
    expect(container.textContent).toBe('settings:integrations.partnerApps.gone');
  });

  it('asks first, then disconnects, reports it and goes back', async () => {
    mocks.data = TWO_APPS;
    mocks.params = { id: 'connection-sequence' };
    mocks.mutate.mockImplementation((_variables, callbacks) => {
      callbacks.onSuccess?.();
      callbacks.onSettled?.();
    });
    const { getByLabelText } = render(<ConnectedAppDetailScreen />);
    fireEvent.click(getByLabelText(SEQUENCE_DISCONNECT));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: 'settings:integrations.partnerApps.disconnectConfirmTitle {"app":"Sequence"}',
      message: 'settings:integrations.partnerApps.disconnectConfirmBody {"app":"Sequence"}',
      confirmLabel: 'settings:integrations.partnerApps.disconnect',
      cancelLabel: 'settings:integrations.partnerApps.cancel',
      destructive: true,
    });
    expect(mocks.mutate.mock.calls[0][0]).toEqual({ connectionId: 'connection-sequence' });
    expect(mocks.showToast).toHaveBeenCalledWith(
      'settings:integrations.partnerApps.disconnected {"app":"Sequence"}',
      'success',
    );
    expect(mocks.back).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the climber cancels', async () => {
    mocks.data = TWO_APPS;
    mocks.params = { id: 'connection-sequence' };
    mocks.confirmResult = false;
    const { getByLabelText } = render(<ConnectedAppDetailScreen />);
    fireEvent.click(getByLabelText(SEQUENCE_DISCONNECT));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.back).not.toHaveBeenCalled();
  });

  it('stays on the app and says so when Disconnect fails', async () => {
    mocks.data = TWO_APPS;
    mocks.params = { id: 'connection-divepeaks' };
    mocks.mutate.mockImplementation((_variables, callbacks) => {
      callbacks.onError?.();
      callbacks.onSettled?.();
    });
    const { getByLabelText } = render(<ConnectedAppDetailScreen />);
    fireEvent.click(getByLabelText('settings:integrations.partnerApps.disconnectA11y {"app":"DivePeaks"}'));
    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith(
        'settings:integrations.partnerApps.disconnectFailed {"app":"DivePeaks"}',
        'error',
      ),
    );
    expect(mocks.back).not.toHaveBeenCalled();
  });
});
