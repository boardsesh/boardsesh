// @vitest-environment jsdom
//
// The screenshot-mode gate on the "Email me project news" switch. Its footer
// mentions supporting Boardsesh, and store captures never show anything about
// that, so the screen must hand the model no switch AND never ask the server
// for the answer while EXPO_PUBLIC_SCREENSHOT_MODE is '1'. No store Maestro
// flow opens Settings › Account, so this test is the only guard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MoreFormModel } from '../../../MoreForm.types';

const state = vi.hoisted(() => ({
  model: null as MoreFormModel | null,
  request: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../MoreForm', () => ({
  MoreForm: ({ model }: { model: MoreFormModel }) => {
    state.model = model;
    return null;
  },
}));
vi.mock('../../../../lib/routing/scoped-navigation', () => ({ scopedRouter: { push: vi.fn() } }));
vi.mock('../../../../hooks/use-confirm-sign-out', () => ({ useConfirmSignOut: () => vi.fn() }));
vi.mock('../../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: { id: 'climber-1', email: 'alex@example.com' } }),
}));
vi.mock('../../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request: state.request }) }));
vi.mock('../../../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => 1,
  isAuthCredentialGenerationCurrent: () => true,
}));
vi.mock('../../../../lib/connectivity/connectivity-store', () => ({
  getConnectivitySnapshot: () => ({ effectiveOffline: false }),
}));
vi.mock('../../../../lib/connectivity/use-connectivity', () => ({
  selectEffectiveOffline: () => false,
  useConnectivityField: () => false,
}));
vi.mock('../../../../lib/haptics', () => ({ hapticLight: vi.fn(), hapticSelection: vi.fn() }));
vi.mock('../../../../lib/settings-analytics', () => ({
  withSettingTracking: (model: MoreFormModel) => model,
}));
vi.mock('../../../../providers/auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../../root/use-sync-issues', () => ({ useSyncIssuesSection: () => null }));

async function renderScreen() {
  // SCREENSHOT_MODE is read once at module load, so each case imports a fresh copy.
  vi.resetModules();
  const { AccountSettingsScreen } = (await import('../AccountSettingsScreen')) as {
    AccountSettingsScreen: ComponentType;
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client: queryClient }, createElement(AccountSettingsScreen)));
}

function sectionKeys(): string[] {
  return state.model?.sections.map((section) => section.key) ?? [];
}

describe('AccountSettingsScreen project news switch', () => {
  beforeEach(() => {
    state.model = null;
    state.request.mockReset();
    state.request.mockResolvedValue({
      myProjectNewsEmailConsent: { subscribed: false, updatedAt: null, source: null },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it('leaves the switch out and never asks the server in screenshot mode', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    await renderScreen();

    expect(sectionKeys()).toContain('accountActions');
    expect(sectionKeys()).not.toContain('projectNewsEmail');
    // Give any stray query a tick to fire before asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.request).not.toHaveBeenCalled();
  });

  it('shows the switch and loads the answer for a signed-in climber outside screenshot mode', async () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '');
    await renderScreen();

    expect(sectionKeys()).toContain('projectNewsEmail');
    await waitFor(() => expect(state.request).toHaveBeenCalledTimes(1));
  });
});
