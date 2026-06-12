// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const preference = vi.hoisted(() => ({
  targetSeconds: 180,
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
  }: {
    options: Array<{ key: string; label: string }>;
    selectedKey: string;
    onSelect: (key: string) => void;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'div',
      { role: 'radiogroup', 'aria-label': accessibilityLabel },
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
    brandColors: { primary: '#123' },
  }),
}));
vi.mock('../../../../theme/tokens', () => ({ spacing: { 3: 12 } }));
vi.mock('../../../../lib/rep-timer-preference', () => ({
  REP_TIMER_TARGET_SECONDS: [60, 120, 180, 300],
  useRepTimerPreference: () => ({
    targetSeconds: preference.targetSeconds,
    setTargetSeconds: preference.setTargetSeconds,
  }),
}));

import { RepTimerSettingsCard } from '../RepTimerSettingsCard';

describe('RepTimerSettingsCard', () => {
  beforeEach(() => {
    preference.targetSeconds = 180;
    preference.setTargetSeconds.mockClear();
  });

  it('renders timer target options and persists selection changes', () => {
    const { getByRole, getByText } = render(<RepTimerSettingsCard />);

    expect(getByText('mobile.session.repTimerTitle')).not.toBeNull();
    expect(getByRole('button', { name: '3m' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(getByRole('button', { name: '5m' }));

    expect(preference.setTargetSeconds).toHaveBeenCalledWith(300);
  });
});
