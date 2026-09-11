// @vitest-environment jsdom
//
// The arm row is the only way a climber turns the timer ON, so these drive the
// REAL store: flipping the switch must arm it with the persisted cadence and the
// session it belongs to — including the pre-session case, where there is no
// session id yet and the arm has to carry in on its own.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type SwitchProps = {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
};

const harness = vi.hoisted(() => ({
  nowMs: 0,
  enabled: true,
  sessionId: null as string | null,
  settings: { restTimerMode: 'afterTick' } as Record<string, unknown>,
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-testid': 'card' }, children),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({ label, description, value, onValueChange, disabled }: SwitchProps) =>
    createElement('button', {
      'data-switch': label,
      'data-value': String(value),
      'data-description': description ?? '',
      onClick: () => {
        if (!disabled) onValueChange(!value);
      },
    }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#111111', secondaryLabel: '#666666' } }),
}));

vi.mock('../../../providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: harness.sessionId }),
}));

vi.mock('../../../providers/feature-flags-provider', () => ({ useRestTimerEnabled: () => harness.enabled }));

vi.mock('../../../settings', () => ({ getSetting: (key: string) => harness.settings[key] }));

vi.mock('../../../lib/clock', () => ({ nowMs: () => harness.nowMs }));

vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));

vi.mock('../../queue-control/RestTimerPill', () => ({
  RestTimerClock: () => createElement('span', { 'data-testid': 'arm-row-clock' }),
}));

vi.mock('../../queue-control/RestTimerSheet', () => ({
  RestTimerLengthControl: ({ inset }: { inset?: boolean }) =>
    createElement('div', { 'data-testid': 'length-control', 'data-inset': String(inset !== false) }),
  RestTimerAutoAdvanceRow: () => createElement('div', { 'data-testid': 'auto-advance-row' }),
}));

import { armRestTimer, getRestTimerState, resetRestTimerStoreForTests } from '../../../lib/rest-timer-store';
import { RestTimerArmRow } from '../RestTimerArmRow';

const NOW_MS = Date.parse('2026-09-11T10:00:00.000Z');
const ARM_SWITCH = '[data-switch="mobile.restTimer.armLabel"]';

describe('RestTimerArmRow', () => {
  beforeEach(() => {
    harness.nowMs = NOW_MS;
    harness.enabled = true;
    harness.sessionId = 'session-1';
    harness.settings = { restTimerMode: 'afterTick' };
  });

  afterEach(() => {
    cleanup();
    resetRestTimerStoreForTests();
  });

  it('stays off the screen entirely while the rollout flag is off', () => {
    harness.enabled = false;
    const { queryByTestId } = render(<RestTimerArmRow />);
    expect(queryByTestId('card')).toBeNull();
  });

  it('arms the real store with the persisted cadence and the live session', () => {
    const { container } = render(<RestTimerArmRow />);

    fireEvent.click(container.querySelector(ARM_SWITCH) as HTMLElement);

    const state = getRestTimerState();
    expect(state.armed).toBe(true);
    expect(state.armedForSessionId).toBe('session-1');
    // `afterTick` has nothing to count from until the first tick lands.
    expect(state.anchorMs).toBeNull();
  });

  it('anchors on the spot when the persisted cadence is on-the-minute', () => {
    harness.settings = { restTimerMode: 'onTheMinute' };
    const { container } = render(<RestTimerArmRow />);

    fireEvent.click(container.querySelector(ARM_SWITCH) as HTMLElement);
    expect(getRestTimerState().anchorMs).toBe(NOW_MS);
  });

  it('arms before a session exists, carrying no session id', () => {
    harness.sessionId = null;
    const { container } = render(<RestTimerArmRow />);

    fireEvent.click(container.querySelector(ARM_SWITCH) as HTMLElement);
    expect(getRestTimerState().armed).toBe(true);
    expect(getRestTimerState().armedForSessionId).toBeNull();
  });

  it('disarms the real store when switched back off', () => {
    armRestTimer('afterTick', NOW_MS, 'session-1');
    const { container } = render(<RestTimerArmRow />);

    expect(container.querySelector(ARM_SWITCH)?.getAttribute('data-value')).toBe('true');
    fireEvent.click(container.querySelector(ARM_SWITCH) as HTMLElement);
    expect(getRestTimerState().armed).toBe(false);
  });

  it('reveals the length + auto-advance controls and the live clock only once armed', () => {
    const { container, queryByTestId } = render(<RestTimerArmRow />);
    expect(queryByTestId('length-control')).toBeNull();
    expect(queryByTestId('auto-advance-row')).toBeNull();

    fireEvent.click(container.querySelector(ARM_SWITCH) as HTMLElement);

    expect(queryByTestId('length-control')).not.toBeNull();
    expect(queryByTestId('auto-advance-row')).not.toBeNull();
    expect(queryByTestId('arm-row-clock')).not.toBeNull();
  });

  it('drops the sheet gutter on the length control, which already sits in a padded card', () => {
    armRestTimer('afterTick', NOW_MS, 'session-1');
    const { getByTestId } = render(<RestTimerArmRow />);
    expect(getByTestId('length-control').getAttribute('data-inset')).toBe('false');
  });
});
