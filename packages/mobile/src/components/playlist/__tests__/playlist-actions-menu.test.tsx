// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode, type Ref } from 'react';

const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));
const modal = vi.hoisted(() => ({ present: vi.fn(), dismiss: vi.fn() }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('@gorhom/bottom-sheet', () => ({ BottomSheetModal: function BottomSheetModal() {} }));
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
  ListRow: ({ title, leading }: { title: string; leading?: ReactNode }) =>
    createElement('div', { 'data-row': title }, leading),
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

const baseProps = {
  visible: true,
  onTogglePin: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onClose: vi.fn(),
};

beforeEach(() => {
  ctrl.variant = 'liquidGlass';
  modal.present.mockClear();
  modal.dismiss.mockClear();
});

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
});
