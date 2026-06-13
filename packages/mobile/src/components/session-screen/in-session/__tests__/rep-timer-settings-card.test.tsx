// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const preference = vi.hoisted(() => ({
  targetSeconds: 180 as 180 | null,
  loaded: true,
  setTargetSeconds: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../Card', () => ({
  Card: ({ children }: { children?: ReactNode }) => createElement('section', null, children),
}));
vi.mock('../../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../SegmentedControl', () => ({
  SegmentedControl: ({
    options,
    selectedKey,
    onSelect,
    accessibilityLabel,
    selectedTrackColor,
    selectedTextColor,
  }: {
    options: Array<{ key: string; label: string }>;
    selectedKey: string | null;
    onSelect: (key: string) => void;
    accessibilityLabel?: string;
    selectedTrackColor?: string;
    selectedTextColor?: string;
  }) =>
    createElement(
      'div',
      {
        role: 'radiogroup',
        'aria-label': accessibilityLabel,
        'data-selected-track-color': selectedTrackColor ?? '',
        'data-selected-text-color': selectedTextColor ?? '',
      },
      options.map((option) =>
        createElement(
          'button',
          {
            key: option.key,
            type: 'button',
            'aria-pressed': selectedKey === option.key,
            onClick: () => onSelect(option.key),
          },
          option.label,
        ),
      ),
    ),
}));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { tertiaryBackground: '#eee', secondaryLabel: '#666' },
    brandColors: { primary: '#123', primaryFill: '#456', onPrimary: '#fff' },
  }),
}));
vi.mock('../../../../theme/tokens', () => ({ spacing: { 1: 4, 3: 12 } }));
vi.mock('../../../../lib/rep-timer-preference', () => ({
  REP_TIMER_TARGET_SECONDS: [60, 120, 180, 300],
  useRepTimerPreference: () => ({
    targetSeconds: preference.targetSeconds,
    loaded: preference.loaded,
    setTargetSeconds: preference.setTargetSeconds,
  }),
}));

import { RepTimerSettingsCard } from '../RepTimerSettingsCard';

describe('RepTimerSettingsCard', () => {
  beforeEach(() => {
    preference.targetSeconds = 180;
    preference.loaded = true;
    preference.setTargetSeconds.mockClear();
  });

  it('renders timer target options and persists selection changes', () => {
    const { getByRole, getByText } = render(<RepTimerSettingsCard />);

    expect(getByText('mobile.session.repTimerTitle')).not.toBeNull();
    const group = getByRole('radiogroup', { name: 'mobile.session.repTimerTargetAria' });
    expect(group.getAttribute('data-selected-track-color')).toBe('#456');
    expect(group.getAttribute('data-selected-text-color')).toBe('#fff');
    expect(getByRole('button', { name: '3m' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(getByRole('button', { name: '5m' }));

    expect(preference.setTargetSeconds).toHaveBeenCalledWith(300);
  });

  it('supports turning the timer off', () => {
    preference.targetSeconds = null;
    const { getByRole } = render(<RepTimerSettingsCard />);

    expect(getByRole('button', { name: 'mobile.session.repTimerOff' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(getByRole('button', { name: '2m' }));
    expect(preference.setTargetSeconds).toHaveBeenCalledWith(120);

    fireEvent.click(getByRole('button', { name: 'mobile.session.repTimerOff' }));
    expect(preference.setTargetSeconds).toHaveBeenCalledWith(null);
  });

  it('does not show a selected target before the preference loads', () => {
    preference.loaded = false;
    const { getByRole } = render(<RepTimerSettingsCard />);

    expect(getByRole('button', { name: '3m' }).getAttribute('aria-pressed')).toBe('false');
    expect(getByRole('button', { name: 'mobile.session.repTimerOff' }).getAttribute('aria-pressed')).toBe('false');
  });
});
