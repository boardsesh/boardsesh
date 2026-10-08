// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const recording = vi.hoisted(() => ({ enabled: true, save: vi.fn(), apply: vi.fn() }));
const switchEvent = vi.hoisted(() => ({ change: null as ((next: boolean) => void) | null }));
vi.mock('../../../lib/session-recording-preference', () => ({
  useSessionRecordingPreference: () => ({ enabled: recording.enabled, setEnabled: recording.save }),
}));
vi.mock('../../../lib/analytics', () => ({ setSessionRecordingEnabled: recording.apply }));
vi.mock('../../SwitchRow', () => ({
  SwitchRow: ({
    label,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    value: boolean;
    disabled: boolean;
    onValueChange: (next: boolean) => void;
  }) => {
    switchEvent.change = onValueChange;
    return createElement(
      'button',
      { role: 'switch', disabled, 'aria-checked': value, onClick: () => onValueChange(!value) },
      label,
    );
  },
}));

import { SessionRecordingSwitchRow } from '../SessionRecordingSwitchRow';
import { updateConsentState } from '../../../lib/consent-state';
import { grantAnalyticsForTest } from '../../../../test/consent-fixture';

afterEach(cleanup);

it('hides a saved recording preference until consent, and rejects callbacks after withdrawal', () => {
  grantAnalyticsForTest();
  updateConsentState({ record: null, settled: false });
  render(createElement(SessionRecordingSwitchRow, { label: 'Recording', description: 'Recording preference' }));
  expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  act(() => switchEvent.change?.(true));
  expect(recording.save).not.toHaveBeenCalled();
  expect(recording.apply).not.toHaveBeenCalled();

  act(grantAnalyticsForTest);
  expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  const grantedCallback = switchEvent.change;
  fireEvent.click(screen.getByRole('switch'));
  expect(recording.save).toHaveBeenCalledExactlyOnceWith(false);
  expect(recording.apply).toHaveBeenCalledExactlyOnceWith(false);

  act(() => updateConsentState({ record: null, settled: false }));
  expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
  act(() => grantedCallback?.(true));
  expect(recording.save).toHaveBeenCalledTimes(1);
  expect(recording.apply).toHaveBeenCalledTimes(1);
});
