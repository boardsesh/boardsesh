// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const env = vi.hoisted(() => ({
  os: 'web' as string,
  scheme: 'light' as 'light' | 'dark' | null,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return env.os;
    },
  },
  useColorScheme: () => env.scheme,
  StyleSheet: {
    hairlineWidth: 1,
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: unknown) => styles,
  },
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement(
      'div',
      {
        'data-testid': 'crash-container',
        'data-background': String(Object.assign({}, ...[style].flat(10).filter(Boolean)).backgroundColor ?? 'unset'),
      },
      children,
    ),
}));
vi.mock('../Text', () => ({
  Text: ({ children, color, style }: { children?: ReactNode; color?: string; style?: unknown }) =>
    createElement(
      'span',
      {
        'data-color': color ?? 'unset',
        'data-opacity': String(Object.assign({}, ...[style].flat(10).filter(Boolean)).opacity ?? 'unset'),
      },
      children,
    ),
}));
vi.mock('../Icon', () => ({ Icon: () => null }));
vi.mock('../PressableSurface', () => ({ PressableSurface: () => null }));
vi.mock('expo-updates', () => ({ isEnabled: false, updateId: null, isEmbeddedLaunch: true, channel: null }));
vi.mock('expo-router', () => ({ router: { replace: vi.fn() } }));
vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn(), reportHandledError: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn(), getAnalyticsClient: vi.fn() }));
vi.mock('../../lib/ota-recovery', () => ({ performOtaRecovery: vi.fn() }));
vi.mock('../../lib/ota-operation-owner', () => ({ runOtaOperation: vi.fn() }));
vi.mock('../../lib/qa/qa-surf', () => ({
  captureOtaReloadReceipt: vi.fn(),
  fetchOwnedOtaUpdate: vi.fn(),
  isOtaReloadReceiptCurrent: vi.fn(),
  waitForOtaUpdatesIdle: vi.fn(),
  waitForOtaReloadReceipt: vi.fn(),
}));
vi.mock('../../lib/screenshot-smoke', () => ({ reportScreenshotSmokeError: vi.fn() }));

import { CrashScreen, resolveCrashScreenPalette } from '../CrashScreen';
import { brandColors, brandColorsDark, materialSurfaces } from '../../theme/colors';

const crash = new Error('boom');

function renderCrash() {
  return render(createElement(CrashScreen, { error: crash, retry: vi.fn() }));
}

beforeEach(() => {
  env.os = 'web';
  env.scheme = 'light';
});

describe('CrashScreen palette', () => {
  it('paints web in the dark Velvet colours even when the browser scheme is light', () => {
    renderCrash();
    expect(screen.getByText('Something went wrong').getAttribute('data-color')).toBe(materialSurfaces.dark.label);
    expect(screen.getByText(/unexpected error/).getAttribute('data-color')).toBe(materialSurfaces.dark.secondaryLabel);
    expect(screen.getAllByTestId('crash-container')[0].getAttribute('data-background')).toBe(
      materialSurfaces.dark.background,
    );
  });

  it('does not dim the muted label on the dark palette (keeps 4.5:1 contrast)', () => {
    renderCrash();
    expect(screen.getByText(/unexpected error/).getAttribute('data-opacity')).toBe('unset');
  });

  it('dims the message only on the system-default native light path', () => {
    env.os = 'ios';
    env.scheme = 'light';
    renderCrash();
    expect(screen.getByText(/unexpected error/).getAttribute('data-opacity')).toBe('0.7');
  });

  it('paints native dark in the dark Velvet colours', () => {
    env.os = 'ios';
    env.scheme = 'dark';
    renderCrash();
    expect(screen.getByText('Something went wrong').getAttribute('data-color')).toBe(materialSurfaces.dark.label);
    expect(screen.getAllByTestId('crash-container')[0].getAttribute('data-background')).toBe(
      materialSurfaces.dark.background,
    );
  });

  it('leaves native light on the system defaults', () => {
    env.os = 'ios';
    env.scheme = 'light';
    renderCrash();
    expect(screen.getByText('Something went wrong').getAttribute('data-color')).toBe('unset');
    expect(screen.getAllByTestId('crash-container')[0].getAttribute('data-background')).toBe('unset');
  });

  it('resolves the four platform and scheme combinations', () => {
    expect(resolveCrashScreenPalette('web', 'light').brand).toBe(brandColorsDark);
    expect(resolveCrashScreenPalette('web', 'dark').brand).toBe(brandColorsDark);
    expect(resolveCrashScreenPalette('android', 'dark').brand).toBe(brandColorsDark);
    expect(resolveCrashScreenPalette('android', 'light').brand).toBe(brandColors);
  });
});
