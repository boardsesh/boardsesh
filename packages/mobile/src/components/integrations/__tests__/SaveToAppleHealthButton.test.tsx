// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { SessionSummary } from '@boardsesh/shared-schema';

const mocks = vi.hoisted(() => ({
  saveState: 'idle',
  platform: 'ios',
  manualSave: vi.fn(),
  showToast: vi.fn(),
}));

type RowProps = {
  children?: ReactNode;
  accessibilityRole?: string;
  accessibilityLabel?: string;
  accessibilityState?: { busy?: boolean };
  accessibilityLiveRegion?: string;
  onPress?: () => void;
};

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mocks.platform;
    },
  },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  View: ({ children, accessibilityRole, accessibilityLabel, accessibilityState, accessibilityLiveRegion }: RowProps) =>
    createElement(
      'div',
      {
        role: accessibilityRole,
        'aria-label': accessibilityLabel,
        'aria-busy': accessibilityState?.busy,
        'aria-live': accessibilityLiveRegion,
      },
      children,
    ),
}));

vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, accessibilityLabel, onPress }: RowProps) =>
    createElement('button', { 'aria-label': accessibilityLabel, onClick: onPress }, children),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));
vi.mock('../../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('i', { 'data-spinner': true }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      secondaryLabel: '#888',
      secondaryBackground: '#fff',
      accent: '#609',
      tertiaryLabel: '#aaa',
    },
  }),
}));
vi.mock('../../../providers/toast-provider', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 3: 12, 4: 16 },
  borderRadius: { lg: 12 },
}));
vi.mock('../../../lib/integrations', () => ({
  useHealthKitSaveState: () => mocks.saveState,
  manualSaveToAppleHealth: mocks.manualSave,
}));

import { SaveToAppleHealthButton } from '../SaveToAppleHealthButton';

const summary: SessionSummary = {
  sessionId: 'session-1',
  totalSends: 1,
  totalFlashes: 0,
  totalAttempts: 2,
  gradeDistribution: [],
  participants: [],
};

describe('SaveToAppleHealthButton', () => {
  beforeEach(() => {
    mocks.saveState = 'idle';
    mocks.platform = 'ios';
    mocks.manualSave.mockReset();
    mocks.manualSave.mockResolvedValue('saved');
    mocks.showToast.mockReset();
  });

  it.each([
    ['saved', 'summary.savedToAppleHealth'],
    ['savedWithoutEnergy', 'summary.savedToAppleHealthWithoutCalories'],
  ])('renders %s as an accessible noninteractive status', (saveState, label) => {
    mocks.saveState = saveState;
    const { container, getByLabelText, queryByRole } = render(<SaveToAppleHealthButton summary={summary} />);
    expect(getByLabelText(label).getAttribute('aria-live')).toBe('polite');
    expect(queryByRole('button')).toBeNull();
    expect(container.querySelector('[data-icon="check.small"]')).not.toBeNull();
    fireEvent.click(getByLabelText(label));
    expect(mocks.manualSave).not.toHaveBeenCalled();
  });

  it('announces saving as busy without another save action', () => {
    mocks.saveState = 'saving';
    const { container, getByLabelText, queryByRole } = render(<SaveToAppleHealthButton summary={summary} />);
    expect(getByLabelText('summary.savingToAppleHealth').getAttribute('aria-busy')).toBe('true');
    expect(queryByRole('button')).toBeNull();
    expect(container.querySelector('[data-spinner]')).not.toBeNull();
  });

  it.each([
    ['idle', 'summary.saveToAppleHealth'],
    ['failed', 'summary.saveToAppleHealthRetry'],
  ])('keeps the %s action connected to the manual save', async (saveState, label) => {
    mocks.saveState = saveState;
    const exportContext = { boardType: 'kilter' };
    const { getByRole } = render(<SaveToAppleHealthButton summary={summary} exportContext={exportContext} />);
    fireEvent.click(getByRole('button', { name: label }));
    await waitFor(() => expect(mocks.manualSave).toHaveBeenCalledWith(summary, exportContext));
  });

  it('preserves permission-denied feedback', async () => {
    mocks.manualSave.mockResolvedValue('denied');
    const { getByRole } = render(<SaveToAppleHealthButton summary={summary} />);
    fireEvent.click(getByRole('button'));
    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith('integrations.appleHealth.permissionDenied', 'error'),
    );
  });

  it('does not render the Apple Health action on Android', () => {
    mocks.platform = 'android';
    const { container } = render(<SaveToAppleHealthButton summary={summary} />);
    expect(container.childElementCount).toBe(0);
  });
});
