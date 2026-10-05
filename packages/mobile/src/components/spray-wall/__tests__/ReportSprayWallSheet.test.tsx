// @vitest-environment jsdom
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
  ModalSheet: ({ children, footer }: { children: ReactNode; footer: ReactNode }) =>
    createElement('div', null, children, footer),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled }, title),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, radii: { button: 10 } }),
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
