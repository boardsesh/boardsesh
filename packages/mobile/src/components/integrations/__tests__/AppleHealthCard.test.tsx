// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// --- Hoisted mock state, mutated per-test before render ---
const mocks = vi.hoisted(() => ({
  getAppleHealthAuthorizationStatus: vi.fn<() => Promise<'notDetermined' | 'granted' | 'denied'>>(),
  requestAppleHealthAuthorization: vi.fn<() => Promise<boolean>>(),
  trackAppleHealthIntegrationConnected: vi.fn(),
  enabled: false,
  loaded: true,
  setEnabled: vi.fn(),
  openSettings: vi.fn(),
}));

vi.mock('../../../lib/integrations', () => ({
  getAppleHealthAuthorizationStatus: mocks.getAppleHealthAuthorizationStatus,
  requestAppleHealthAuthorization: mocks.requestAppleHealthAuthorization,
  trackAppleHealthIntegrationConnected: mocks.trackAppleHealthIntegrationConnected,
  useHealthKitAutoSavePreference: () => ({
    enabled: mocks.enabled,
    loaded: mocks.loaded,
    setEnabled: mocks.setEnabled,
  }),
}));

type RNViewProps = { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children }: RNViewProps) => createElement('div', {}, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Platform: { OS: 'ios' },
  Linking: { openSettings: (...args: unknown[]) => mocks.openSettings(...args) },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#fff', secondaryLabel: '#888' },
  }),
}));

type TextMockProps = { children?: ReactNode };
vi.mock('../../Text', () => ({
  Text: ({ children }: TextMockProps) => createElement('span', { 'data-text': 'true' }, children),
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
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
  borderRadius: { lg: 12 },
}));

import { AppleHealthCard } from '../AppleHealthCard';

const toggle = (root: HTMLElement) => root.querySelector('[data-switch]') as HTMLButtonElement | null;

describe('AppleHealthCard', () => {
  beforeEach(() => {
    mocks.getAppleHealthAuthorizationStatus.mockReset();
    mocks.requestAppleHealthAuthorization.mockReset();
    mocks.trackAppleHealthIntegrationConnected.mockReset();
    mocks.setEnabled.mockReset();
    mocks.openSettings.mockReset();
    mocks.enabled = false;
    mocks.loaded = true;
    // 'notDetermined' is safe as the mount-time default: the status probe is
    // read-only and never triggers the OS consent sheet by itself.
    mocks.getAppleHealthAuthorizationStatus.mockResolvedValue('notDetermined');
  });

  it('routes a first-time grant through the shared, dedup-guarded tracker', async () => {
    mocks.requestAppleHealthAuthorization.mockResolvedValue(true);
    const { container } = render(<AppleHealthCard />);

    fireEvent.click(toggle(container)!);

    await waitFor(() => expect(mocks.requestAppleHealthAuthorization).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.trackAppleHealthIntegrationConnected).toHaveBeenCalledTimes(1));
  });

  it('does NOT call the tracker when the permission is denied', async () => {
    mocks.requestAppleHealthAuthorization.mockResolvedValue(false);
    const { container } = render(<AppleHealthCard />);

    fireEvent.click(toggle(container)!);

    await waitFor(() => expect(mocks.requestAppleHealthAuthorization).toHaveBeenCalledTimes(1));
    expect(mocks.trackAppleHealthIntegrationConnected).not.toHaveBeenCalled();
  });

  it('does not re-request authorization (or track) once the status is already decided', async () => {
    mocks.getAppleHealthAuthorizationStatus.mockResolvedValue('granted');
    const { container } = render(<AppleHealthCard />);

    // Let the mount-time status probe resolve first.
    await waitFor(() => expect(mocks.getAppleHealthAuthorizationStatus).toHaveBeenCalledTimes(1));

    fireEvent.click(toggle(container)!);

    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith(true));
    expect(mocks.requestAppleHealthAuthorization).not.toHaveBeenCalled();
    expect(mocks.trackAppleHealthIntegrationConnected).not.toHaveBeenCalled();
  });
});
