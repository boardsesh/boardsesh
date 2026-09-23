// @vitest-environment jsdom
//
// The connect-step pill (#5654, PR 7, treatment only): the play view's bulb
// with a label, and the hook that decides when it replaces the bulb.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import boardsCatalog from '@boardsesh/i18n/locales/en-US/boards.json';
import type { ConnectStepEnrolment, FirstConnectDeviceState } from '../../../lib/onboarding/first-connect-decision';

type Children = { children?: ReactNode };

const hapticMock = vi.hoisted(() => vi.fn());
const recordDayMock = vi.hoisted(() => vi.fn(async () => null));
const storeCtrl = vi.hoisted(() => ({
  snapshot: {
    device: null as FirstConnectDeviceState | null,
    userId: 'user-1' as string | null,
    enrolment: null as ConnectStepEnrolment | null,
    cardDismissedThisLaunch: false,
  },
}));
const flagsCtrl = vi.hoisted(() => ({ enabled: true }));
// Local noon, so the day key does not depend on the machine's time zone.
const clockCtrl = vi.hoisted(() => ({ nowMs: new Date(2026, 8, 21, 12, 0, 0).getTime() }));

vi.mock('react-native', () => ({
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    accessibilityState,
  }: Children & { onPress?: () => void; accessibilityLabel?: string; accessibilityState?: { busy?: boolean } }) =>
    createElement(
      'button',
      { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel, 'aria-busy': accessibilityState?.busy },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const found = key
        .split('.')
        .reduce<unknown>(
          (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
          boardsCatalog,
        );
      return typeof found === 'string' ? found : key;
    },
  }),
}));
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../Text', () => ({
  Text: ({ children, maxFontSizeMultiplier }: Children & { maxFontSizeMultiplier?: number }) =>
    createElement('span', { 'data-max-font-scale': maxFontSizeMultiplier }, children),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('div', { 'data-spinner': 'true' }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primaryFill: '#6D28D9', onPrimary: '#fff' } }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticMedium: hapticMock }));
vi.mock('../../../theme/tokens', () => ({
  androidRipple: () => ({ color: '#fff', borderless: false }),
  spacing: { 2: 8, 4: 16 },
}));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2 }));
vi.mock('../../../theme/layout', () => ({ glassSize: { inline: 44 } }));
vi.mock('../../../lib/clock', () => ({ nowMs: () => clockCtrl.nowMs }));
vi.mock('../../../lib/onboarding/first-connect-store', () => ({
  useFirstConnectSelector: <Selected,>(select: (current: typeof storeCtrl.snapshot) => Selected) =>
    select(storeCtrl.snapshot),
  recordFirstConnectPillDay: recordDayMock,
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useFirstConnectCtaEnabled: () => flagsCtrl.enabled,
}));

const { FirstConnectPill } = await import('../FirstConnectPill');
const { useFirstConnectPill } = await import('../use-first-connect-pill');

function freshDevice(overrides: Partial<FirstConnectDeviceState> = {}): FirstConnectDeviceState {
  return {
    connectedAt: null,
    noLightsAt: null,
    confirmationShownAt: null,
    cardLaunchIds: [],
    pillDays: [],
    ...overrides,
  };
}

describe('FirstConnectPill', () => {
  afterEach(() => {
    cleanup();
    hapticMock.mockClear();
  });

  it('says what the bulb does and runs the bulb’s tap', () => {
    const onPress = vi.fn();
    render(<FirstConnectPill pending={false} onPress={onPress} />);

    const pill = screen.getByLabelText('Light it on the board');
    expect(pill.textContent).toBe('Light it on the board');
    fireEvent.click(pill);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(hapticMock).toHaveBeenCalledTimes(1);
  });

  it('caps the label’s font scale like the other chrome labels', () => {
    const { container } = render(<FirstConnectPill pending={false} onPress={vi.fn()} />);
    expect(container.querySelector('[data-max-font-scale="1.2"]')).not.toBeNull();
  });

  it('ignores taps while a connect is in flight', () => {
    const onPress = vi.fn();
    const { container } = render(<FirstConnectPill pending onPress={onPress} />);

    fireEvent.click(screen.getByLabelText('Light it on the board'));
    expect(onPress).not.toHaveBeenCalled();
    expect(container.querySelector('[data-spinner="true"]')).not.toBeNull();
  });
});

describe('useFirstConnectPill', () => {
  beforeEach(() => {
    storeCtrl.snapshot = {
      device: freshDevice(),
      userId: 'user-1',
      enrolment: { userId: 'user-1', arm: 'treatment', forced: false, exposedAt: 1 },
      cardDismissedThisLaunch: false,
    };
    flagsCtrl.enabled = true;
    recordDayMock.mockClear();
  });

  it('shows in the treatment wherever a tap would connect, and counts the day', () => {
    const { result } = renderHook(() => useFirstConnectPill(true));

    expect(result.current).toBe(true);
    expect(recordDayMock).toHaveBeenCalledWith('2026-09-21');
  });

  it('does not show, or count a day, where a tap would not connect', () => {
    const { result } = renderHook(() => useFirstConnectPill(false));

    expect(result.current).toBe(false);
    expect(recordDayMock).not.toHaveBeenCalled();
  });

  it('stops after three days', () => {
    storeCtrl.snapshot.device = freshDevice({ pillDays: ['2026-09-17', '2026-09-18', '2026-09-19'] });
    expect(renderHook(() => useFirstConnectPill(true)).result.current).toBe(false);
  });

  it.each([
    [
      'control',
      () => (storeCtrl.snapshot.enrolment = { userId: 'user-1', arm: 'control', forced: false, exposedAt: 1 }),
    ],
    ['the kill switch on', () => (flagsCtrl.enabled = false)],
    ['after the first connect', () => (storeCtrl.snapshot.device = freshDevice({ connectedAt: 5 }))],
    ['after "no lights"', () => (storeCtrl.snapshot.device = freshDevice({ noLightsAt: 5 }))],
  ])('gives the plain bulb back %s', (_label, arrange) => {
    arrange();
    expect(renderHook(() => useFirstConnectPill(true)).result.current).toBe(false);
  });
});
