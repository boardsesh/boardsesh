// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode, type Ref } from 'react';

const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));
const modal = vi.hoisted(() => ({ present: vi.fn(), dismiss: vi.fn() }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('@expo/ui/community/bottom-sheet', () => ({ BottomSheetModal: function BottomSheetModal() {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../ModalSheet', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    ModalSheet: React.forwardRef(({ children }: { children?: ReactNode }, ref: Ref<unknown>) => {
      React.useImperativeHandle(ref, () => ({ present: modal.present, dismiss: modal.dismiss }));
      return React.createElement('div', { 'data-modal-sheet': 'true' }, children);
    }),
  };
});
vi.mock('../../ListRow', () => ({
  ListRow: ({ title, leading, onPress }: { title: string; leading?: ReactNode; onPress?: () => void }) =>
    createElement('button', { 'data-row': title, onClick: onPress }, leading),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: unknown }) =>
    createElement('span', { 'data-icon': name, 'data-color': typeof color === 'string' ? color : '' }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => {
    const label = '#000';
    return {
      variant: ctrl.variant,
      systemColors: { label, accent: '#007AFF' },
      brandColors: { primary: '#6D28D9' },
      // Resolved action-icon colours: monochrome on Liquid Glass, semantic on Material.
      actionColors:
        ctrl.variant === 'material'
          ? { neutral: label, success: label, favorite: '#FF3B30', accent: '#007AFF', pin: '#6D28D9' }
          : { neutral: label, success: label, favorite: label, accent: label, pin: label },
    };
  },
}));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemRed: '#FF3B30' } }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8 } }));

import { PlaylistActionsMenu } from '../PlaylistActionsMenu';

const handlers = {
  onTogglePin: vi.fn(),
  onAddClimbs: vi.fn(),
  onEditDetails: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onClose: vi.fn(),
};

const baseProps = { visible: true, ...handlers };

beforeEach(() => {
  ctrl.variant = 'liquidGlass';
  modal.present.mockClear();
  modal.dismiss.mockClear();
  for (const handler of Object.values(handlers)) handler.mockClear();
});

const rowTitles = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-row]')).map((row) => row.getAttribute('data-row'));

describe('PlaylistActionsMenu', () => {
  it('uses neutral pin/edit icons and destructive delete in Liquid Glass', () => {
    const { container } = render(<PlaylistActionsMenu {...baseProps} isPinned />);

    expect(container.querySelector('[data-icon="pin.fill"]')?.getAttribute('data-color')).toBe('#000');
    expect(container.querySelector('[data-icon="edit"]')?.getAttribute('data-color')).toBe('#000');
    expect(container.querySelector('[data-icon="delete"]')?.getAttribute('data-color')).toBe('#FF3B30');
  });

  it('keeps Material pin/edit actions on primary/accent colors', () => {
    ctrl.variant = 'material';
    const { container, rerender } = render(<PlaylistActionsMenu {...baseProps} isPinned />);

    expect(container.querySelector('[data-icon="pin.fill"]')?.getAttribute('data-color')).toBe('#6D28D9');
    expect(container.querySelector('[data-icon="edit"]')?.getAttribute('data-color')).toBe('#007AFF');

    rerender(<PlaylistActionsMenu {...baseProps} isPinned={false} />);
    expect(container.querySelector('[data-icon="pin"]')?.getAttribute('data-color')).toBe('#007AFF');
  });

  it('lays the owner rows out pin / add / details / climbs / delete', () => {
    const { container } = render(<PlaylistActionsMenu {...baseProps} isPinned={false} />);

    expect(rowTitles(container)).toEqual([
      'library.pin.pin',
      'detail.menu.addClimbs',
      'detail.menu.editDetails',
      'detail.menu.editClimbs',
      'detail.menu.delete',
    ]);
  });

  it('drops the add-climbs row (and its snap height) when the caller omits the handler', () => {
    const { container } = render(<PlaylistActionsMenu {...baseProps} onAddClimbs={undefined} isPinned={false} />);

    expect(rowTitles(container)).toEqual([
      'library.pin.pin',
      'detail.menu.editDetails',
      'detail.menu.editClimbs',
      'detail.menu.delete',
    ]);
  });

  // #3966: these rows used to hand their work to the sheet's `onClose`, which
  // the coordinator suppresses on a controlled close, so the taps did nothing.
  // Each row must call its own handler, and none of them may touch `onClose`.
  it('fires each row handler exactly once on press and never leans on onClose', () => {
    const { container } = render(<PlaylistActionsMenu {...baseProps} isPinned={false} />);

    const press = (title: string) => fireEvent.click(container.querySelector(`[data-row="${title}"]`) as HTMLElement);
    press('library.pin.pin');
    press('detail.menu.addClimbs');
    press('detail.menu.editDetails');
    press('detail.menu.editClimbs');
    press('detail.menu.delete');

    expect(handlers.onTogglePin).toHaveBeenCalledTimes(1);
    expect(handlers.onAddClimbs).toHaveBeenCalledTimes(1);
    expect(handlers.onEditDetails).toHaveBeenCalledTimes(1);
    expect(handlers.onEdit).toHaveBeenCalledTimes(1);
    expect(handlers.onDelete).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).not.toHaveBeenCalled();
  });
});
