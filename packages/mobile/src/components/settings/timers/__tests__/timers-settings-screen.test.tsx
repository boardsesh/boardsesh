// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoreFormModel, MoreSelectRow, MoreSegmentedRow, MoreToggleRow } from '../../../MoreForm.types';

const captured = vi.hoisted(() => ({ model: null as MoreFormModel | null }));
const values = vi.hoisted(() => new Map<string, unknown>());
const analytics = vi.hoisted(() => ({ track: vi.fn() }));
const driver = vi.hoisted(() => ({ blockedReason: null as 'crewPassenger' | null }));
const sound = vi.hoisted(() => ({ available: false }));
const modeChange = vi.hoisted(() => ({ change: vi.fn(() => true) }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../MoreForm', () => ({
  MoreForm: ({ model }: { model: MoreFormModel }) => {
    captured.model = model;
    return null;
  },
}));
vi.mock('../../../../lib/analytics', () => ({ track: analytics.track }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../../hooks/use-session-timer-driver', () => ({
  useSessionTimerDriver: () => ({ blockedReason: driver.blockedReason }),
}));
vi.mock('../../../../providers/queue-provider', () => ({ useQueueSessionId: () => ({ sessionId: 'session-1' }) }));
vi.mock('../../../../lib/rest-timer-cues', () => ({ isRestTimerSoundAvailable: () => sound.available }));
vi.mock('../../../../lib/rest-timer-mode-change', () => ({ changeRestTimerMode: modeChange.change }));
vi.mock('../../../../settings', async () => {
  const react = await import('react');
  return {
    useSetting: (key: string) => {
      const [, bump] = react.useReducer((count: number) => count + 1, 0);
      return [
        values.get(key),
        (next: unknown) => {
          values.set(key, next);
          bump();
        },
      ];
    },
  };
});

import { TimersSettingsScreen } from '../TimersSettingsScreen';

function row<T>(key: string, kind: string): T {
  const found = captured.model?.sections.flatMap((section) => section.rows).find((candidate) => candidate.key === key);
  if (found?.kind !== kind) throw new Error(`no ${kind} row ${key}`);
  return found as T;
}

beforeEach(() => {
  values.clear();
  values.set('restTimerTargetSeconds', 120);
  values.set('restTimerMode', 'afterTick');
  values.set('restTimerAutoAdvance', false);
  values.set('restTimerCountdownCues', true);
  values.set('restTimerSound', true);
  captured.model = null;
  driver.blockedReason = null;
  sound.available = false;
  analytics.track.mockClear();
  modeChange.change.mockClear();
});
afterEach(cleanup);

describe('TimersSettingsScreen', () => {
  it('shows the saved rest defaults', () => {
    render(<TimersSettingsScreen />);
    expect(row<MoreSelectRow>('restLength', 'select').selectedKey).toBe('120');
    expect(row<MoreSegmentedRow>('restMode', 'segmented').selectedKey).toBe('afterTick');
    expect(row<MoreToggleRow>('autoAdvance', 'toggle').value).toBe(false);
  });

  it('saves a rest length and reports one change under the timers page', () => {
    render(<TimersSettingsScreen />);
    row<MoreSelectRow>('restLength', 'select').onSelect('300');
    expect(values.get('restTimerTargetSeconds')).toBe(300);
    expect(analytics.track).toHaveBeenCalledWith('Setting Changed', {
      page: 'timers',
      key: 'restLength',
      value: '300',
    });
  });

  it('turns Off into a null length', () => {
    render(<TimersSettingsScreen />);
    row<MoreSelectRow>('restLength', 'select').onSelect('off');
    expect(values.get('restTimerTargetSeconds')).toBeNull();
  });

  it('sends a cadence change through the shared re-arm rule', () => {
    render(<TimersSettingsScreen />);
    row<MoreSegmentedRow>('restMode', 'segmented').onSelect('onTheMinute');
    expect(modeChange.change).toHaveBeenCalledWith('onTheMinute', 'session-1');
  });

  it('reports a cadence change under the timers page', () => {
    render(<TimersSettingsScreen />);
    row<MoreSegmentedRow>('restMode', 'segmented').onSelect('onTheMinute');
    expect(analytics.track).toHaveBeenCalledWith('Setting Changed', {
      page: 'timers',
      key: 'restMode',
      value: 'onTheMinute',
    });
  });

  it('disables auto-advance and asks for a rest length when the length is Off', () => {
    values.set('restTimerTargetSeconds', null);
    render(<TimersSettingsScreen />);
    const autoAdvance = row<MoreToggleRow>('autoAdvance', 'toggle');
    expect(autoAdvance.disabled).toBe(true);
    expect(autoAdvance.subtitle).toBe('mobile.settings.timers.autoAdvanceNeedsLength');
  });

  it('saves the auto-advance toggle when it is enabled', () => {
    render(<TimersSettingsScreen />);
    const autoAdvance = row<MoreToggleRow>('autoAdvance', 'toggle');
    expect(autoAdvance.disabled).toBe(false);
    autoAdvance.onValueChange(true);
    expect(values.get('restTimerAutoAdvance')).toBe(true);
  });

  it('disables auto-advance for a crew passenger', () => {
    driver.blockedReason = 'crewPassenger';
    render(<TimersSettingsScreen />);
    expect(row<MoreToggleRow>('autoAdvance', 'toggle').disabled).toBe(true);
  });

  it('leaves the countdown row out while nothing reads it', () => {
    render(<TimersSettingsScreen />);
    expect(captured.model?.sections.flatMap((section) => section.rows).map((r) => r.key)).not.toContain(
      'countdownCues',
    );
  });

  it('leaves the sound row out when this build cannot play one', () => {
    render(<TimersSettingsScreen />);
    expect(captured.model?.sections.flatMap((section) => section.rows).map((r) => r.key)).not.toContain('sound');
  });

  it('shows and writes the sound row when it can', () => {
    sound.available = true;
    render(<TimersSettingsScreen />);
    row<MoreToggleRow>('sound', 'toggle').onValueChange(false);
    expect(values.get('restTimerSound')).toBe(false);
  });
});
