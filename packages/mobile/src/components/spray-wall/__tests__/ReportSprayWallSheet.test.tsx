// @vitest-environment jsdom
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => async () => false }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { ReportSprayWallSheet } from '../ReportSprayWallSheet';
const state = vi.hoisted(() => ({
  canReport: true,
  offline: false,
  isPending: false,
  isSuccess: false,
  isError: false,
}));
const mutate = vi.hoisted(() => vi.fn());
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  ActivityIndicator: () => createElement('span', { role: 'progressbar' }),
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
    accessibilityState,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled?: boolean;
    accessibilityLabel: string;
    accessibilityState: { checked?: boolean; disabled?: boolean; busy?: boolean };
  }) =>
    createElement(
      'button',
      { onClick: onPress, disabled, 'aria-label': accessibilityLabel, 'aria-pressed': accessibilityState.checked },
      children,
    ),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../ModalSheet', () => ({
  ModalSheet: ({ children, header }: { children: ReactNode; header: ReactNode }) =>
    createElement('div', null, header, children),
}));
vi.mock('../../SheetTopBar', async () => (await import('../../../test/sheet-top-bar-stub')).sheetTopBarModule);
vi.mock('../../Text', () => ({
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));
// The native RadioGroup (SwiftUI inline Picker / Compose RadioButtons): one radio
// per option, checked from `value`, picking through `onChange`.
vi.mock('../../RadioGroup', () => ({
  RadioGroup: ({
    options,
    value,
    onChange,
  }: {
    options: { value: string; label: string; disabled?: boolean }[];
    value: string | null;
    onChange: (next: string) => void;
  }) =>
    createElement(
      'div',
      { role: 'radiogroup' },
      options.map((option) =>
        createElement('button', {
          key: option.value,
          role: 'radio',
          'aria-label': option.label,
          'aria-pressed': option.value === value,
          'aria-disabled': option.disabled ? 'true' : 'false',
          onClick: () => onChange(option.value),
        }),
      ),
    ),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, radii: { button: 10 }, chartColors: { label: '#16111F' } }),
}));
vi.mock('../../../lib/connectivity/use-connectivity', () => ({
  useConnectivity: () => ({ effectiveOffline: state.offline }),
}));
vi.mock('../../../lib/spray/use-spray-moderation', () => ({
  useSprayModerationAccess: () => ({ canReport: state.canReport }),
  useReportSprayWall: () => ({
    mutate,
    isPending: state.isPending,
    isSuccess: state.isSuccess,
    isError: state.isError,
  }),
}));
beforeEach(() => {
  Object.assign(state, { canReport: true, offline: false, isPending: false, isSuccess: false, isError: false });
  mutate.mockReset();
});
describe('ReportSprayWallSheet', () => {
  it.each([
    ['inappropriate', 'INAPPROPRIATE'],
    ['notAWall', 'NOT_A_WALL'],
    ['personalInfo', 'PERSONAL_INFO'],
    ['other', 'OTHER'],
  ])('submits fixed reason %s and prevents same-turn duplicates', (label, reason) => {
    const screen = render(<ReportSprayWallSheet wallUuid="wall-a" wallName="Crew wall" onClose={vi.fn()} />);
    expect((screen.getByText('sprayModeration.submit').closest('button') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(`sprayModeration.reasons.${label}`));
    fireEvent.click(screen.getByText('sprayModeration.submit'));
    fireEvent.click(screen.getByText('sprayModeration.submit'));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ input: { wallUuid: 'wall-a', reason } }, expect.anything());
  });
  it('retains selected reason after failure and permits retry after settling', () => {
    const screen = render(<ReportSprayWallSheet wallUuid="wall-a" wallName="Crew wall" onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('sprayModeration.reasons.personalInfo'));
    fireEvent.click(screen.getByText('sprayModeration.submit'));
    mutate.mock.calls[0][1].onSettled();
    state.isError = true;
    screen.rerender(<ReportSprayWallSheet wallUuid="wall-a" wallName="Crew wall" onClose={vi.fn()} />);
    expect(screen.getByText('sprayModeration.reportError')).toBeTruthy();
    expect(screen.getByLabelText('sprayModeration.reasons.personalInfo').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByText('sprayModeration.submit'));
    expect(mutate).toHaveBeenCalledTimes(2);
  });
  it('lists the reasons in one native RadioGroup with nothing picked yet', () => {
    const screen = render(<ReportSprayWallSheet wallUuid="wall-a" wallName="Crew wall" onClose={vi.fn()} />);
    const radios = screen.getAllByRole('radio');
    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
    expect(radios.map((radio) => radio.getAttribute('aria-label'))).toEqual([
      'sprayModeration.reasons.inappropriate',
      'sprayModeration.reasons.notAWall',
      'sprayModeration.reasons.personalInfo',
      'sprayModeration.reasons.other',
    ]);
    expect(radios.every((radio) => radio.getAttribute('aria-pressed') === 'false')).toBe(true);
  });
  it('locks the reason group while the report is in flight', () => {
    const screen = render(<ReportSprayWallSheet wallUuid="wall-a" wallName="Crew wall" onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('sprayModeration.reasons.other'));
    state.isPending = true;
    screen.rerender(<ReportSprayWallSheet wallUuid="wall-a" wallName="Crew wall" onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('sprayModeration.reasons.inappropriate'));
    expect(screen.getByLabelText('sprayModeration.reasons.other').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByLabelText('sprayModeration.reasons.inappropriate').getAttribute('aria-pressed')).toBe('false');
  });
  it('keeps the pending report disabled and announces its progress', () => {
    state.isPending = true;
    const screen = render(<ReportSprayWallSheet wallUuid="wall-a" wallName="Crew wall" onClose={vi.fn()} />);
    expect((screen.getByText('sprayModeration.submit').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('progressbar')).toBeTruthy();
    fireEvent.click(screen.getByText('sprayModeration.submit'));
    expect(mutate).not.toHaveBeenCalled();
  });
  it('blocks reporting offline or after access is withdrawn', () => {
    state.offline = true;
    const screen = render(<ReportSprayWallSheet wallUuid="wall-a" wallName="Crew wall" onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('sprayModeration.reasons.other'));
    fireEvent.click(screen.getByText('sprayModeration.submit'));
    expect(mutate).not.toHaveBeenCalled();
    state.canReport = false;
    screen.rerender(<ReportSprayWallSheet wallUuid="wall-a" wallName="Crew wall" onClose={vi.fn()} />);
    expect(screen.getByText('sprayModeration.unavailable')).toBeTruthy();
  });
  it('shows a quiet confirmation after either successful server status', () => {
    state.isSuccess = true;
    const screen = render(<ReportSprayWallSheet wallUuid="wall-a" wallName="Crew wall" onClose={vi.fn()} />);
    expect(screen.getByText('sprayModeration.reported')).toBeTruthy();
    expect(screen.queryByText('sprayModeration.submit')).toBeNull();
  });
});
