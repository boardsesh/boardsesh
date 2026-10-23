// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { ScopeDownloadProgress } from '@boardsesh/offline-sync';
import type { DownloadActivity } from '../../../sync/download-activity-store';

const state = vi.hoisted(() => ({
  activity: null as DownloadActivity | null,
  pathname: '/you',
  hidden: false,
  boards: [{ boardType: 'kilter', layoutId: 8, sizeId: 1, name: 'Garage wall' }],
}));
const spies = vi.hoisted(() => ({ push: vi.fn(), track: vi.fn(), publishHeight: vi.fn() }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityValue,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityValue?: { min?: number; max?: number; now?: number };
  }) =>
    createElement(
      'button',
      {
        onClick: onPress,
        'aria-label': accessibilityLabel,
        'aria-valuemin': accessibilityValue?.min,
        'aria-valuemax': accessibilityValue?.max,
        'aria-valuenow': accessibilityValue?.now,
      },
      children,
    ),
}));
vi.mock('expo-router', () => ({ usePathname: () => state.pathname, useRouter: () => ({ push: spies.push }) }));
vi.mock('../../../sync/download-activity-store', () => ({ useDownloadActivity: () => state.activity }));
vi.mock('../../../settings', async () => {
  const { useState } = await import('react');
  return {
    useOfflineBoards: () => state.boards,
    useSetting: () => {
      const [hidden, setHidden] = useState(state.hidden);
      return [
        hidden,
        (next: boolean) => {
          state.hidden = next;
          setHidden(next);
        },
      ];
    },
  };
});
vi.mock('../../../lib/analytics', () => ({ track: spies.track }));
vi.mock('../../../lib/connectivity-banner-inset-store', () => ({
  publishBottomOverlayHeight: spies.publishHeight,
  useConnectivityCardHeight: () => 0,
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ connectivityBannerBottom: 80 }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      secondaryBackground: '#eee',
      tertiaryBackground: '#ddd',
      separator: '#ccc',
      secondaryLabel: '#888',
    },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12 }, borderRadius: { sm: 4, lg: 12 } }));
vi.mock('react-i18next', async () => {
  const { createInstance } = await import('i18next');
  const { default: catalog } = await import('@boardsesh/i18n/locales/en-US/boards.json');
  const translations = createInstance();
  await translations.init({ lng: 'en-US', resources: { 'en-US': { boards: catalog } } });
  return { useTranslation: () => ({ t: translations.getFixedT('en-US', 'boards') }) };
});

import { publishSheetVisibility } from '../../../lib/sheet-visibility-store';
import { LaunchReadyProvider } from '../../../providers/launch-ready-context';
import { OfflineDownloadPill } from '../OfflineDownloadPill';

function activity(
  progress: Partial<ScopeDownloadProgress> = {},
  status: DownloadActivity['status'] = 'active',
): DownloadActivity {
  return {
    status,
    progress: {
      scopeKey: 'kilter:8:1',
      phase: 'grades',
      fraction: 0.524,
      wireBytes: 100,
      wireBytesDone: 100,
      queuedScopes: 2,
      ...progress,
    },
  };
}

function ReadyPill({ ready = true }: { ready?: boolean }) {
  return (
    <LaunchReadyProvider ready={ready}>
      <OfflineDownloadPill />
    </LaunchReadyProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '0');
  state.pathname = '/you';
  state.hidden = false;
  state.activity = activity();
  publishSheetVisibility(false);
});
afterEach(() => {
  cleanup();
  publishSheetVisibility(false);
  vi.unstubAllEnvs();
});

describe('OfflineDownloadPill', () => {
  it('shows the board, current phase, rounded percent and waiting-board count accessibly', () => {
    render(<ReadyPill />);

    expect(screen.getByText('Garage wall')).toBeTruthy();
    expect(screen.getByText('Loading grades… · 52% · +2 more')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Open My Boards for Garage wall. Loading grades…' });
    expect(button.getAttribute('aria-valuemin')).toBe('0');
    expect(button.getAttribute('aria-valuemax')).toBe('100');
    expect(button.getAttribute('aria-valuenow')).toBe('52');
  });

  it.each([
    ['preparing', 'Preparing download…'],
    ['downloading', 'Downloading board…'],
    ['unpacking', 'Unpacking climbs…'],
    ['grades', 'Loading grades…'],
    ['finishing', 'Finishing download…'],
  ] as const)('describes the %s phase', (phase, label) => {
    state.activity = activity({ phase, queuedScopes: 0 });
    render(<ReadyPill />);

    expect(screen.getByText(`${label} · 52%`)).toBeTruthy();
    expect(screen.queryByText(/more/)).toBeNull();
  });

  it('opens My Boards and records which download was tapped', () => {
    render(<ReadyPill />);
    fireEvent.click(screen.getByRole('button', { name: /^Open My Boards/ }));

    expect(spies.push).toHaveBeenCalledWith('/boards/manage');
    expect(spies.track).toHaveBeenCalledWith(SHARED_EVENTS.OfflineDownloadIndicatorTapped, {
      scopeKey: 'kilter:8:1',
      phase: 'grades',
    });
  });

  it.each(['/boards', '/boards/manage', '/boards/garage', '/play', '/play/climb'])('stays hidden on %s', (pathname) => {
    state.pathname = pathname;
    render(<ReadyPill />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(spies.publishHeight).toHaveBeenCalledWith('download', 0);
  });

  it('yields to a managed sheet and returns when it closes', () => {
    render(<ReadyPill />);
    expect(screen.getByRole('button', { name: /^Open My Boards/ })).toBeTruthy();

    act(() => publishSheetVisibility(true));
    expect(screen.queryByRole('button')).toBeNull();
    expect(spies.publishHeight).toHaveBeenCalledWith('download', 0);

    act(() => publishSheetVisibility(false));
    expect(screen.getByRole('button', { name: /^Open My Boards/ })).toBeTruthy();
  });

  it('waits for launch readiness before appearing', () => {
    const { rerender } = render(<ReadyPill ready={false} />);
    expect(screen.queryByRole('button')).toBeNull();

    rerender(<ReadyPill ready />);
    expect(screen.getByRole('button', { name: /^Open My Boards/ })).toBeTruthy();
  });

  it('keeps waiting progress indeterminate instead of inventing a percentage', () => {
    state.activity = activity({ phase: 'preparing', fraction: null }, 'waiting');
    render(<ReadyPill />);

    expect(screen.getByText('Waiting to download… · +2 more')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Open My Boards/ }).getAttribute('aria-valuenow')).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it('hides when no download remains', () => {
    state.activity = null;
    render(<ReadyPill />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('stays out of screenshot captures', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    render(<ReadyPill />);

    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('download progress dismissal', () => {
  it.each(['active', 'waiting', 'failed', 'done'] as const)(
    'hides a %s download without stopping its activity',
    (status) => {
      state.activity = activity({}, status);
      const currentActivity = state.activity;
      const { rerender, unmount } = render(<ReadyPill />);
      fireEvent.click(screen.getByRole('button', { name: 'Hide download progress' }));
      expect(screen.queryByRole('button')).toBeNull();
      expect(state.activity).toBe(currentActivity);
      expect(spies.push).not.toHaveBeenCalled();
      expect(spies.publishHeight).toHaveBeenCalledWith('download', 0);
      state.activity = activity({ fraction: 0.9, queuedScopes: 1 }, status);
      rerender(<ReadyPill />);
      expect(screen.queryByRole('button')).toBeNull();
      unmount();
      render(<ReadyPill />);
      expect(screen.queryByRole('button')).toBeNull();
    },
  );

  it('shows a live count without a guessed percentage during final paging', () => {
    state.activity = activity({ phase: 'finishing', fraction: null, rowsProcessed: 1500, queuedScopes: 0 });
    render(<ReadyPill />);
    expect(screen.getByText('Finishing download… · 1500 items loaded')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Open My Boards/ }).hasAttribute('aria-valuenow')).toBe(false);
  });
});
