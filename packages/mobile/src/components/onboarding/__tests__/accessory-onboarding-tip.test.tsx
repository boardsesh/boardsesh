// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { ONBOARDING_TIP_ACCESSORY_KEY } from '@boardsesh/key-value-storage';
import commonCatalog from '@boardsesh/i18n/locales/en-US/common.json';

type SurfaceProps = {
  children?: ReactNode;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
};
const state = vi.hoisted(() => ({
  platform: 'android',
  hasClimb: true,
  barVisible: true,
  seen: false,
  hasSeenTip: vi.fn<() => Promise<boolean>>(),
  markTipSeen: vi.fn<() => Promise<void>>(),
}));

function flattenStyle(style: StyleProp<ViewStyle>): ViewStyle {
  return Object.assign({}, ...[style].flat(10).filter(Boolean));
}

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return state.platform;
    },
  },
  View: ({ children }: SurfaceProps) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'actions.close' ? 'Close' : commonCatalog.mobile.onboarding.tips.accessory),
  }),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, accessibilityRole, accessibilityLabel, onPress, style }: SurfaceProps) =>
    createElement(
      'button',
      {
        type: 'button',
        role: accessibilityRole,
        'aria-label': accessibilityLabel,
        onClick: onPress,
        style: flattenStyle(style),
      },
      children,
    ),
}));
vi.mock('../../Text', () => ({ Text: ({ children }: SurfaceProps) => createElement('span', null, children) }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primary: '#604' }, systemColors: { secondaryBackground: '#fff' } }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/onboarding/onboarding-storage', () => ({
  hasSeenTip: state.hasSeenTip,
  markTipSeen: state.markTipSeen,
}));
vi.mock('../../../hooks/use-sticky-accessory-presence', () => ({
  useStickyAccessoryPresence: () => state.hasClimb,
}));
vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({
    nativeAccessoryVisible: false,
    jsQueueToolbarVisible: state.barVisible,
    floatingControlBottom: 120,
  }),
}));

const { AccessoryOnboardingTip } = await import('../AccessoryOnboardingTip');
const { OnboardingTipBanner } = await import('../OnboardingTipBanner');
const copy = commonCatalog.mobile.onboarding.tips.accessory;

beforeEach(() => {
  state.hasClimb = true;
  state.barVisible = true;
  state.seen = false;
  state.hasSeenTip.mockReset().mockImplementation(async () => state.seen);
  state.markTipSeen.mockReset().mockImplementation(async () => {
    state.seen = true;
  });
});
afterEach(cleanup);

describe('AccessoryOnboardingTip dismissal (#7416)', () => {
  it.each(['text', 'close'])('dismisses from %s and stays dismissed after remounting', async (target) => {
    const tip = render(createElement(AccessoryOnboardingTip));
    await screen.findByRole('button', { name: 'Close' });
    fireEvent.click(screen.getByRole('button', { name: target === 'text' ? copy : 'Close' }));
    expect(screen.queryByText(copy)).toBeNull();
    expect(state.markTipSeen).toHaveBeenCalledExactlyOnceWith(ONBOARDING_TIP_ACCESSORY_KEY);
    tip.unmount();
    render(createElement(AccessoryOnboardingTip));
    await act(async () => {});
    expect(screen.queryByText(copy)).toBeNull();
  });

  it('keeps dismissal for this launch when storage fails and the bar returns', async () => {
    state.markTipSeen.mockRejectedValue(new Error('Storage unavailable'));
    const tip = render(createElement(AccessoryOnboardingTip));
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    await act(async () => {});
    state.hasClimb = false;
    tip.rerender(createElement(AccessoryOnboardingTip));
    state.hasClimb = true;
    tip.rerender(createElement(AccessoryOnboardingTip));
    await act(async () => {});
    expect(screen.queryByText(copy)).toBeNull();
    expect(state.hasSeenTip).toHaveBeenCalledTimes(1);
  });

  it('ignores an outstanding seen check after dismissal', async () => {
    const tip = render(createElement(AccessoryOnboardingTip));
    await screen.findByRole('button', { name: 'Close' });
    state.hasClimb = false;
    tip.rerender(createElement(AccessoryOnboardingTip));
    let resolveSeen: (seen: boolean) => void = () => {};
    state.hasSeenTip.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSeen = resolve;
        }),
    );
    state.hasClimb = true;
    tip.rerender(createElement(AccessoryOnboardingTip));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => {
      resolveSeen(false);
    });
    expect(screen.queryByText(copy)).toBeNull();
  });

  it('waits for a visible bar and hides while the bar is covered', async () => {
    state.barVisible = false;
    const tip = render(createElement(AccessoryOnboardingTip));
    await waitFor(() => expect(state.hasSeenTip).toHaveBeenCalled());
    expect(screen.queryByText(copy)).toBeNull();
    state.barVisible = true;
    tip.rerender(createElement(AccessoryOnboardingTip));
    expect(screen.getByText(copy)).toBeTruthy();
    state.barVisible = false;
    tip.rerender(createElement(AccessoryOnboardingTip));
    expect(screen.queryByText(copy)).toBeNull();
  });

  it('does not show a tip that was already dismissed', async () => {
    state.seen = true;
    render(createElement(AccessoryOnboardingTip));
    await act(async () => {});
    expect(screen.queryByText(copy)).toBeNull();
  });
});

describe('OnboardingTipBanner controls', () => {
  it('gives the Android close button a real 48dp target without shrinking', () => {
    render(createElement(OnboardingTipBanner, { text: copy, dismissLabel: 'Close', onDismiss: vi.fn() }));
    const close = screen.getByRole('button', { name: 'Close' });
    expect(parseFloat(close.style.minWidth)).toBeGreaterThanOrEqual(48);
    expect(parseFloat(close.style.minHeight)).toBeGreaterThanOrEqual(48);
    expect(close.style.flexShrink).toBe('0');
  });

  it('preserves separate body and close actions for other contextual tips', () => {
    const onPress = vi.fn();
    const onDismiss = vi.fn();
    render(createElement(OnboardingTipBanner, { text: 'Board history', dismissLabel: 'Close', onPress, onDismiss }));
    fireEvent.click(screen.getByRole('button', { name: 'Board history' }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
