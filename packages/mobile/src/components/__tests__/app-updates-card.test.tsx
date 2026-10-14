// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const state = vi.hoisted(() => ({
  context: {
    channel: 'production',
    branch: null as string | null,
    updateId: 'running-update',
    runtimeVersion: 'native-runtime',
    isEmbeddedLaunch: false,
    automaticCanary: false as boolean | null,
  },
  member: false,
  earlyState: 'off' as 'off' | 'on' | 'waiting' | 'leaving' | 'testing',
  earlyAvailable: true,
  earlyOffered: true,
  stagingAvailable: true,
  prNumber: null as number | null,
  surfingAvailable: true,
  surfToStaging: vi.fn(),
  returnToOwnTrack: vi.fn(),
  setEarlyUpdatesChoice: vi.fn(),
  showToast: vi.fn(),
  push: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({ router: { push: state.push } }));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children) }));
vi.mock('../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../Button', () => ({ Button: () => null }));
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
    accessibilityState,
  }: {
    children?: ReactNode;
    onPress: () => void;
    disabled?: boolean;
    accessibilityLabel: string;
    accessibilityState?: { expanded?: boolean };
  }) =>
    createElement(
      'button',
      { onClick: onPress, disabled, 'aria-label': accessibilityLabel, 'aria-expanded': accessibilityState?.expanded },
      children,
    ),
}));
vi.mock('../AppMenu', () => ({
  AppMenu: ({
    actions,
    onSelectIndex,
  }: {
    actions: { label: string; disabled?: boolean }[];
    onSelectIndex: (index: number) => void;
  }) =>
    createElement(
      'div',
      {},
      actions.map((action, index) =>
        createElement(
          'button',
          { key: action.label, disabled: action.disabled, onClick: () => onSelectIndex(index) },
          action.label,
        ),
      ),
    ),
}));
vi.mock('../SwitchRow', () => ({
  SwitchRow: ({
    label,
    description,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    description?: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (next: boolean) => void;
  }) =>
    createElement(
      'label',
      {},
      label,
      description,
      createElement('input', {
        type: 'checkbox',
        'aria-label': label,
        checked: value,
        disabled,
        onChange: () => onValueChange(!value),
      }),
    ),
}));
vi.mock('../../lib/release-context', () => ({ readMobileReleaseContext: () => state.context }));
vi.mock('../../lib/use-mobile-release-status', () => ({
  useMobileReleaseStatus: () => ({ releaseContext: state.context, isPending: false }),
}));
vi.mock('../../lib/qa/qa-surf', () => ({
  qaSurfingAvailable: () => state.surfingAvailable,
  surfToStaging: state.surfToStaging,
}));
vi.mock('../../lib/qa/early-updates', () => ({
  returnToOwnTrack: state.returnToOwnTrack,
  setEarlyUpdatesChoice: state.setEarlyUpdatesChoice,
}));
vi.mock('../../lib/qa/use-early-updates', () => ({
  useEarlyUpdatesMember: () => state.member,
  useEarlyUpdatesRow: () => ({
    show: state.earlyOffered,
    state: state.earlyState,
    environment: { surfingBuild: true, surfingReady: true, flagsResolved: true, flag: 'on', flagOffConfirmed: false },
  }),
}));
vi.mock('../../lib/qa/use-qa-menu', () => ({ useQaMenu: () => ({ show: true, prNumber: state.prNumber }) }));
vi.mock('../../lib/qa/use-qa-branches', () => ({
  useQaBranches: () => ({
    data: {
      kind: 'listed',
      list: { earlyUpdates: state.earlyAvailable ? {} : null, staging: state.stagingAvailable ? {} : null },
    },
  }),
}));
vi.mock('../../lib/error-reporting', () => ({ reportHandledError: vi.fn() }));
vi.mock('../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../providers/toast-provider', () => ({ useToast: () => ({ showToast: state.showToast }) }));
vi.mock('../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {}, brandColors: {} }) }));

import { AppUpdatesCard } from '../AppUpdatesCard';
import { appReleaseLabel, screenshotReleaseScenario } from '../AppUpdatesCard.logic';

function expandOptions() {
  fireEvent.click(screen.getByLabelText('mobile.changelog.updates.options'));
}

function renderCard() {
  return render(
    createElement(AppUpdatesCard, {
      buildDetails: createElement('span', {}, 'Build details'),
      checkForUpdates: (disabled, onBusyChange) =>
        createElement(
          'div',
          {},
          createElement('button', { disabled, onClick: () => onBusyChange(true) }, 'Check now'),
          createElement('button', { onClick: () => onBusyChange(false) }, 'Done checking'),
        ),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  state.context = {
    channel: 'production',
    branch: null,
    updateId: 'running-update',
    runtimeVersion: 'native-runtime',
    isEmbeddedLaunch: false,
    automaticCanary: false,
  };
  state.member = false;
  state.earlyState = 'off';
  state.earlyAvailable = true;
  state.earlyOffered = true;
  state.stagingAvailable = true;
  state.prNumber = null;
  state.surfingAvailable = true;
  state.returnToOwnTrack.mockReset().mockResolvedValue('production-next-launch');
  state.surfToStaging.mockReset().mockResolvedValue('staging-next-launch');
  state.setEarlyUpdatesChoice.mockReset().mockResolvedValue('joined');
});

describe('App updates card', () => {
  it('explains a verified automatic canary and includes build details', () => {
    state.context.automaticCanary = true;
    renderCard();
    expect(screen.getByText('mobile.changelog.updates.canary')).toBeTruthy();
    expect(screen.getByText('mobile.changelog.updates.canaryBody')).toBeTruthy();
    expect(screen.getByText('Build details')).toBeTruthy();
  });
  it('shows unknown status without claiming the user is a canary', () => {
    state.context.automaticCanary = null;
    renderCard();
    expect(screen.queryByText('mobile.changelog.updates.canary')).toBeNull();
    expect(screen.getByText('mobile.changelog.updates.statusUnknown')).toBeTruthy();
  });
  it.each([
    ['pr-12', 'preview'],
    ['pr-staging', 'staging'],
    ['pr-beta', 'early'],
  ] as const)('labels running %s independently from the production channel', (branch, label) => {
    expect(appReleaseLabel({ ...state.context, branch }).key).toBe(`mobile.changelog.updates.${label}`);
  });
  it('returns an early member to a compatible early update', async () => {
    state.member = true;
    state.returnToOwnTrack.mockResolvedValue('early-updates-next-launch');
    renderCard();
    expandOptions();
    fireEvent.click(screen.getByText('qa.pick.earlyUpdatesTitle'));
    expect(state.returnToOwnTrack).toHaveBeenCalledExactlyOnceWith(true);
    await waitFor(() => expect(state.showToast).toHaveBeenCalledWith('qa.pick.earlyUpdatesNextLaunch', 'info'));
  });
  it('returns to production while no compatible early update is offered', async () => {
    state.member = true;
    state.earlyAvailable = false;
    renderCard();
    expandOptions();
    fireEvent.click(screen.getByText('qa.pick.productionTitle'));
    expect(state.returnToOwnTrack).toHaveBeenCalledExactlyOnceWith(false);
    await waitFor(() => expect(state.showToast).toHaveBeenCalledWith('qa.pick.productionNextLaunch', 'info'));
  });
  it('hides staging when no compatible update exists', () => {
    state.stagingAvailable = false;
    renderCard();
    expandOptions();
    expect(screen.queryByText('qa.pick.stagingTitle')).toBeNull();
  });
  it('locks release operations while a switch is in flight and recovers after failure', async () => {
    let rejectSwitch: (error: Error) => void = () => undefined;
    state.surfToStaging.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectSwitch = reject;
        }),
    );
    renderCard();
    expandOptions();
    fireEvent.click(screen.getByText('qa.pick.stagingTitle'));
    fireEvent.click(screen.getByText('qa.pick.productionTitle'));
    expect(state.surfToStaging).toHaveBeenCalledOnce();
    expect(state.returnToOwnTrack).not.toHaveBeenCalled();
    rejectSwitch(new Error('Connection lost'));
    await waitFor(() => expect(state.showToast).toHaveBeenCalledWith('Connection lost', 'error'));
    fireEvent.click(screen.getByText('qa.pick.productionTitle'));
    expect(state.returnToOwnTrack).toHaveBeenCalledOnce();
  });
  it('shows the pending early choice and explains a deferred switch', async () => {
    state.earlyState = 'waiting';
    state.setEarlyUpdatesChoice.mockResolvedValue('deferred');
    renderCard();
    expandOptions();
    const toggle = screen.getByLabelText('mobile.settings.earlyUpdates.title') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(state.showToast).toHaveBeenCalledWith('mobile.settings.earlyUpdates.leaveDeferred', 'info'),
    );
  });
  it('prevents release changes and early flips during an update check', async () => {
    renderCard();
    expandOptions();
    fireEvent.click(screen.getByText('Check now'));
    const disclosure = screen.getByLabelText('mobile.changelog.updates.options') as HTMLButtonElement;
    expect(disclosure.disabled).toBe(true);
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Done checking')).toBeTruthy();
    fireEvent.click(screen.getByText('qa.pick.stagingTitle'));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(state.surfToStaging).not.toHaveBeenCalled();
    expect(state.setEarlyUpdatesChoice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Done checking'));
    fireEvent.click(screen.getByText('qa.pick.stagingTitle'));
    expect(state.surfToStaging).toHaveBeenCalledOnce();
    await waitFor(() => expect(state.showToast).toHaveBeenCalledWith('qa.pick.stagingNextLaunch', 'info'));
  });

  it('explains preview precedence without offering the early toggle', () => {
    state.earlyState = 'testing';
    renderCard();
    expandOptions();
    expect(screen.getByText('mobile.settings.earlyUpdates.testingBody')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('prioritizes finishing the active PR and reveals switching previews on expansion', () => {
    state.prNumber = 12;
    state.context.branch = 'pr-12';
    renderCard();
    expect(screen.getByText('mobile.changelog.updates.preview')).toBeTruthy();
    expect(screen.queryByLabelText('mobile.changelog.updates.testPreview')).toBeNull();
    fireEvent.click(screen.getByLabelText('mobile.changelog.updates.finishTesting'));
    expect(state.push).toHaveBeenCalledWith('/qa/brief');
    expandOptions();
    fireEvent.click(screen.getByLabelText('mobile.changelog.updates.testPreview'));
    expect(state.push).toHaveBeenCalledWith('/qa/previews');
    expect(screen.getAllByLabelText('mobile.changelog.updates.finishTesting')).toHaveLength(1);
  });
  it('keeps the regular summary compact and exposes options with an accessible disclosure', () => {
    const { container } = renderCard();
    const disclosure = screen.getByLabelText('mobile.changelog.updates.options');
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('mobile.changelog.updates.regular')).toBeTruthy();
    expect(screen.getByText('Build details')).toBeTruthy();
    expect(screen.queryByText('Check now')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(container.querySelector('[data-icon="success"]')).toBeNull();
    expect(screen.getAllByLabelText('mobile.changelog.updates.testPreview')).toHaveLength(1);
    fireEvent.click(screen.getByLabelText('mobile.changelog.updates.testPreview'));
    expect(state.push).toHaveBeenCalledWith('/qa/previews');
    expandOptions();
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Check now')).toBeTruthy();
    expect(screen.getByRole('checkbox')).toBeTruthy();
    expect(screen.getAllByLabelText('mobile.changelog.updates.testPreview')).toHaveLength(1);
    expandOptions();
    expect(screen.queryByText('Check now')).toBeNull();
  });
  it('shows the canary explanation even while update options stay collapsed', () => {
    state.context.automaticCanary = true;
    const { container } = renderCard();
    expect(screen.getByText('mobile.changelog.updates.canaryBody')).toBeTruthy();
    expect(screen.queryByText('Check now')).toBeNull();
    expect(container.querySelector('[data-icon="info"]')).toBeTruthy();
    expect(container.querySelector('[data-icon="success"]')).toBeNull();
  });
  it('renders the readonly preview fixture without changing running report identity', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_RELEASE_SCENARIO', 'preview');
    expect(screenshotReleaseScenario()).toBe('preview');
    renderCard();
    expect(screen.getByText('mobile.changelog.updates.preview')).toBeTruthy();
    expect(screen.queryByLabelText('mobile.changelog.updates.testPreview')).toBeNull();
    fireEvent.click(screen.getByLabelText('mobile.changelog.updates.finishTesting'));
    expect(state.push).not.toHaveBeenCalled();
    expect((screen.getByLabelText('mobile.changelog.updates.finishTesting') as HTMLButtonElement).disabled).toBe(true);
    expandOptions();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('mobile.settings.earlyUpdates.testingBody')).toBeTruthy();
    fireEvent.click(screen.getByText('qa.pick.productionTitle'));
    expect(state.returnToOwnTrack).not.toHaveBeenCalled();
    expect(state.context.branch).toBeNull();
    expect(state.context.automaticCanary).toBe(false);
  });
  it('requires screenshot mode for fixtures and does not change report identity', () => {
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_RELEASE_SCENARIO', 'canary');
    expect(screenshotReleaseScenario()).toBeNull();
    vi.stubEnv('EXPO_PUBLIC_SCREENSHOT_MODE', '1');
    state.earlyOffered = false;
    state.surfingAvailable = false;
    renderCard();
    expandOptions();
    expect(screen.getByText('mobile.changelog.updates.canary')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('qa.pick.productionTitle'));
    expect(state.returnToOwnTrack).not.toHaveBeenCalled();
    expect(state.context.automaticCanary).toBe(false);
  });
});
