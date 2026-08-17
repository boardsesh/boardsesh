// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Minimal RN surface. The horizontal ScrollView renders as a tagged div so the
// tests can assert which controls ride the scroller and which stay pinned
// outside it — the whole point of the row's layout.
type PressMockProps = { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string };
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress, accessibilityLabel }: PressMockProps) =>
    createElement('button', { onClick: onPress, 'data-label': accessibilityLabel }, children),
  ScrollView: ({ children, horizontal }: { children?: ReactNode; horizontal?: boolean }) =>
    createElement('div', { 'data-scroll': 'true', 'data-horizontal': horizontal ? 'true' : 'false' }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Paths are relative to THIS file (one level under the source in __tests__), so
// they carry an extra `../`.
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name?: string }) => createElement('span', { 'data-icon': name }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({
  Button: ({ title, disabled }: { title?: string; disabled?: boolean }) =>
    createElement('button', { 'data-save-button': 'true', 'data-title': title, disabled }),
}));
vi.mock('../../Button.surface', () => ({
  ButtonSurfaceProvider: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('../../drawer-action-bar/DrawerActionBar', () => ({
  ActionButton: ({ iconName, accessibilityLabel }: { iconName?: string; accessibilityLabel?: string }) =>
    createElement('button', { 'data-action': iconName, 'data-label': accessibilityLabel }),
  drawerActionBarStyles: { container: {}, rowSecondary: {}, spacer: {} },
}));
vi.mock('../brush-roles', () => ({
  brushRoleColor: () => '#00FF00',
  getPaintRoles: () => ['STARTING', 'HAND', 'FINISH', 'FOOT'],
  useBrushRoleLabels: () => ({ STARTING: 'Start', HAND: 'Hand', FINISH: 'Finish', FOOT: 'Foot' }),
}));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../lib/hold-color-overrides', () => ({ useHoldColorOverrides: () => ({ overrides: {} }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { fill: '#EFEFF0', label: '#000000' } }),
}));
vi.mock('../../../theme/colors', () => ({ brandColors: { primary: '#6D28D9', success: '#047857' } }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 }, borderRadius: { md: 8 } }));

import { CreateDrawerActionBar } from '../CreateDrawerActionBar';

const baseProps = {
  boardName: 'kilter' as const,
  selectedBrush: 'HAND' as const,
  onSelectBrush: vi.fn(),
  canUndo: true,
  canRedo: true,
  onUndo: vi.fn(),
  onRedo: vi.fn(),
  onClear: vi.fn(),
  frameCount: 1,
  currentFrameIndex: 0,
  onDuplicateFrame: vi.fn(),
  onDeleteFrame: vi.fn(),
  onPrevFrame: vi.fn(),
  onNextFrame: vi.fn(),
  canSetActive: true,
  onSetActive: vi.fn(),
  saveState: 'ready' as const,
  onSave: vi.fn(),
};

function renderBar(frameCount: number) {
  const { container } = render(createElement(CreateDrawerActionBar, { ...baseProps, frameCount }));
  return {
    scroller: container.querySelector('[data-scroll="true"]') as HTMLElement,
    setActive: container.querySelector('[data-action="play.circle"]') as HTMLElement,
    save: container.querySelector('[data-save-button="true"]') as HTMLElement,
  };
}

describe('CreateDrawerActionBar', () => {
  it('pins Set Active and Save outside the scrolling editing cluster', () => {
    const { scroller, setActive, save } = renderBar(1);

    expect(scroller.getAttribute('data-horizontal')).toBe('true');
    expect(setActive).toBeTruthy();
    expect(save).toBeTruthy();
    expect(scroller.contains(setActive)).toBe(false);
    expect(scroller.contains(save)).toBe(false);
    // The editing actions are the part allowed to scroll.
    expect(scroller.querySelector('[data-action="undo"]')).toBeTruthy();
    expect(scroller.querySelector('[data-action="copy"]')).toBeTruthy();
  });

  it('puts the multi-frame stepper in the scroller rather than pushing Save off the row', () => {
    const { scroller, setActive, save } = renderBar(3);

    // The four extra controls a multi-frame climb adds...
    expect(scroller.querySelector('[data-action="skip.previous"]')).toBeTruthy();
    expect(scroller.querySelector('[data-action="skip.next"]')).toBeTruthy();
    expect(scroller.querySelector('[data-action="frame.remove"]')).toBeTruthy();
    // ...all land inside it, so the pinned pair is still reachable.
    expect(scroller.contains(setActive)).toBe(false);
    expect(scroller.contains(save)).toBe(false);
  });
});
