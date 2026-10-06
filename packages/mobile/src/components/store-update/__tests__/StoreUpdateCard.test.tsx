// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import commonCatalog from '@boardsesh/i18n/locales/en-US/common.json';
import { StoreUpdateCard } from '../StoreUpdateCard';
import type { StoreUpdateStage } from '../../../lib/store-update/nudge-policy';

type Children = { children?: ReactNode };
const controls = vi.hoisted(() => ({
  stage: 'weekly' as StoreUpdateStage | null,
  platform: 'ios',
  openingStore: false,
  openFailed: false,
  release: { latestVersion: '2.7.0' } as { latestVersion: string } | null,
  acknowledge: vi.fn(),
  openStore: vi.fn(),
}));
vi.mock('../../../lib/store-update/use-store-update-nudge', () => ({
  useStoreUpdateNudge: (enabled: boolean) => ({ ...controls, stage: enabled ? controls.stage : null }),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (variants: Record<string, unknown>) => variants.android ?? variants.default },
  View: ({ children, testID }: Children & { testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, substitutions?: Record<string, string>) => {
      const translated = key
        .split('.')
        .reduce<unknown>(
          (node, segment) =>
            node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined,
          commonCatalog,
        );
      if (typeof translated !== 'string') throw new Error(`Missing common catalog key: ${key}`);
      return translated.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => substitutions?.[name] ?? '');
    },
  }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children, accessibilityRole }: Children & { accessibilityRole?: string }) =>
    createElement(
      accessibilityRole === 'header' ? 'h2' : 'span',
      { role: accessibilityRole === 'alert' ? 'alert' : undefined },
      children,
    ),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) =>
    createElement('button', { type: 'button', onClick: onPress, disabled }, title),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primary: '#a11' },
    systemColors: { secondaryBackground: '#fff', separator: '#ccc', secondaryLabel: '#555' },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(controls, {
    stage: 'weekly',
    platform: 'ios',
    openingStore: false,
    openFailed: false,
    release: { latestVersion: '2.7.0' },
  });
});
afterEach(cleanup);

describe('translated store update card', () => {
  it.each([
    ['weekly', commonCatalog.mobile.storeUpdate.weeklyTitle],
    ['frequent', commonCatalog.mobile.storeUpdate.frequentTitle],
    ['daily', commonCatalog.mobile.storeUpdate.dailyTitle],
  ] as const)('shows %s emphasis with update and dismissal actions', (stage, title) => {
    controls.stage = stage;
    render(createElement(StoreUpdateCard, { enabled: true }));
    expect(screen.getByRole('heading').textContent).toBe(title);
    expect(screen.getByText(commonCatalog.mobile.storeUpdate.iosBody.replace('{{version}}', '2.7.0'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: commonCatalog.mobile.storeUpdate.update }));
    expect(controls.openStore).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: commonCatalog.mobile.storeUpdate.later }));
    expect(controls.acknowledge).toHaveBeenCalledTimes(1);
  });

  it('uses Google Play copy on Android', () => {
    controls.platform = 'android';
    render(createElement(StoreUpdateCard, { enabled: true }));
    expect(screen.getByText(commonCatalog.mobile.storeUpdate.androidBody.replace('{{version}}', '2.7.0'))).toBeTruthy();
  });

  it('keeps both actions available after a failed store link and explains retry', () => {
    controls.openFailed = true;
    render(createElement(StoreUpdateCard, { enabled: true }));
    expect(screen.getByRole('alert').textContent).toBe(commonCatalog.mobile.storeUpdate.openFailed);
    expect(
      (screen.getByRole('button', { name: commonCatalog.mobile.storeUpdate.update }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole('button', { name: commonCatalog.mobile.storeUpdate.later }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('disables both actions during store opening', () => {
    controls.openingStore = true;
    render(createElement(StoreUpdateCard, { enabled: true }));
    for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders nothing when onboarding has priority or release advice is missing', () => {
    const { rerender } = render(createElement(StoreUpdateCard, { enabled: false }));
    expect(screen.queryByTestId('store-update-card')).toBeNull();
    controls.stage = null;
    rerender(createElement(StoreUpdateCard, { enabled: true }));
    expect(screen.queryByTestId('store-update-card')).toBeNull();
    controls.stage = 'daily';
    controls.release = null;
    rerender(createElement(StoreUpdateCard, { enabled: true }));
    expect(screen.queryByTestId('store-update-card')).toBeNull();
  });
});
