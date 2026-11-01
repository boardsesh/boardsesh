// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactElement, type ReactNode } from 'react';

const ctrl = vi.hoisted(() => ({
  widthClass: 'regular' as 'compact' | 'regular',
  board: { uuid: 'wall-1', boardType: 'kilter', layoutId: 1, angle: 40, isAngleAdjustable: true },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../hooks/use-device-layout', () => ({
  useDeviceLayout: () => ({ isPad: true, widthClass: ctrl.widthClass }),
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: ctrl.board }) }));
vi.mock('../../../lib/boards/use-set-board-angle', () => ({ useSetBoardAngle: () => vi.fn() }));
vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../../hooks/use-board-angle-options', () => ({ useBoardAngleOptions: () => [30, 40] }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 4: 16 } }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../SheetTopBar', () => ({ SheetTopBar: () => null }));
vi.mock('../../play-drawer/AngleBoardDiagram', () => ({ AngleBoardDiagram: () => null }));
vi.mock('../../play-drawer/AngleSlider', () => ({ AngleSlider: () => null }));
vi.mock('../../play-drawer/AngleSelectorSheet', () => ({
  AngleSelectorSheet: ({ visible }: { visible: boolean }) =>
    visible ? createElement('div', { 'data-angle-sheet': 'true' }) : null,
}));
vi.mock('../../navigation/AnchoredPopover', () => ({
  AnchoredPopover: ({ visible, trigger }: { visible: boolean; trigger: ReactElement }) =>
    createElement('div', null, trigger, visible ? createElement('div', { 'data-angle-popover': 'true' }) : null),
}));

import { BoardAnglePicker } from '../BoardAnglePicker';

function Picker({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  return (
    <BoardAnglePicker onOpenChange={onOpenChange}>
      {(open) => (
        <button type="button" onClick={open}>
          40°
        </button>
      )}
    </BoardAnglePicker>
  );
}

const shown = (container: HTMLElement) => ({
  popover: container.querySelector('[data-angle-popover]') != null,
  sheet: container.querySelector('[data-angle-sheet]') != null,
});

describe('BoardAnglePicker', () => {
  beforeEach(() => {
    ctrl.widthClass = 'regular';
  });

  it('closes an open popover when the width turns compact, and reports it closed', () => {
    const onOpenChange = vi.fn();
    const { container, getByRole, rerender } = render(<Picker onOpenChange={onOpenChange} />);
    fireEvent.click(getByRole('button'));
    expect(shown(container)).toEqual({ popover: true, sheet: false });
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    ctrl.widthClass = 'compact';
    act(() => rerender(<Picker onOpenChange={onOpenChange} />));
    // Closed, not swapped for a sheet the climber never asked for.
    expect(shown(container)).toEqual({ popover: false, sheet: false });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('closes an open sheet when the width turns regular', () => {
    ctrl.widthClass = 'compact';
    const onOpenChange = vi.fn();
    const { container, getByRole, rerender } = render(<Picker onOpenChange={onOpenChange} />);
    fireEvent.click(getByRole('button'));
    expect(shown(container)).toEqual({ popover: false, sheet: true });

    ctrl.widthClass = 'regular';
    act(() => rerender(<Picker onOpenChange={onOpenChange} />));
    expect(shown(container)).toEqual({ popover: false, sheet: false });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('reports closed when it unmounts while open', () => {
    const onOpenChange = vi.fn();
    const { getByRole, unmount } = render(<Picker onOpenChange={onOpenChange} />);
    fireEvent.click(getByRole('button'));
    unmount();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });
});
