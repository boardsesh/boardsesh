// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { ConnectedApps } from '@boardsesh/shared-schema';

type MutateCallbacks = { onSuccess?: () => void; onError?: () => void; onSettled?: () => void };

const mocks = vi.hoisted(() => ({
  isAuthenticated: true,
  data: undefined as ConnectedApps | undefined,
  mutate: vi.fn<(variables: { connectionId: string }, callbacks: MutateCallbacks) => void>(),
  showToast: vi.fn(),
  confirmResult: true,
  confirm: vi.fn((_options: unknown) => Promise.resolve(mocks.confirmResult)),
}));

vi.mock('../../../lib/graphql/hooks/use-connected-apps', () => ({
  useMyConnectedApps: () => ({ data: mocks.data }),
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
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryGroupedBackground: '#fff', tertiaryGroupedBackground: '#eee', secondaryLabel: '#888' },
    brandColors: { primary: '#6D28D9', warning: '#B45309' },
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-text': 'true' }, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../SectionHeader', () => ({
  SectionHeader: ({ title }: { title: string }) => createElement('h2', {}, title),
}));
type ButtonMockProps = {
  title: string;
  accessibilityLabel?: string;
  onPress?: () => void;
  loading?: boolean;
};
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

describe('PartnerAppsSection', () => {
  beforeEach(() => {
    mocks.isAuthenticated = true;
    mocks.data = undefined;
    mocks.mutate.mockReset();
    mocks.showToast.mockReset();
    mocks.confirm.mockClear();
    mocks.confirmResult = true;
  });

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

  it('shows each app with what it reads, the unlisted-climbs line, when it connected and was used', () => {
    mocks.data = TWO_APPS;
    const { container, getByTestId } = render(<PartnerAppsSection />);
    const sequence = getByTestId('partner-app-connection-sequence');
    expect(sequence.textContent).toContain('Sequence');
    expect(sequence.textContent).toContain('settings:integrations.partnerApps.scopes.logbookRead');
    expect(sequence.textContent).toContain('settings:integrations.partnerApps.scopes.logbookUnlisted');
    expect(sequence.textContent).toContain('settings:integrations.partnerApps.lastUsed');
    const divePeaks = getByTestId('partner-app-connection-divepeaks');
    expect(divePeaks.textContent).toContain('settings:integrations.partnerApps.notUsedYet');
    expect(divePeaks.textContent).toContain('settings:integrations.partnerApps.suspended');
    expect(container.textContent).toContain('settings:integrations.partnerApps.footer');
  });

  it('asks first, then disconnects and reports it', async () => {
    mocks.data = TWO_APPS;
    mocks.mutate.mockImplementation((_variables, callbacks) => {
      callbacks.onSuccess?.();
      callbacks.onSettled?.();
    });
    const { getByLabelText } = render(<PartnerAppsSection />);
    fireEvent.click(getByLabelText('settings:integrations.partnerApps.disconnectA11y {"app":"Sequence"}'));
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
  });

  it('does nothing when the climber cancels', async () => {
    mocks.data = TWO_APPS;
    mocks.confirmResult = false;
    const { getByLabelText } = render(<PartnerAppsSection />);
    fireEvent.click(getByLabelText('settings:integrations.partnerApps.disconnectA11y {"app":"DivePeaks"}'));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('says so when Disconnect fails', async () => {
    mocks.data = TWO_APPS;
    mocks.mutate.mockImplementation((_variables, callbacks) => {
      callbacks.onError?.();
      callbacks.onSettled?.();
    });
    const { getByLabelText } = render(<PartnerAppsSection />);
    fireEvent.click(getByLabelText('settings:integrations.partnerApps.disconnectA11y {"app":"DivePeaks"}'));
    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith(
        'settings:integrations.partnerApps.disconnectFailed {"app":"DivePeaks"}',
        'error',
      ),
    );
  });
});
