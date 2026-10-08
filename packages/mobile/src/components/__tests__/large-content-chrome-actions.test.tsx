// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type Children = { children?: ReactNode };
vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  Alert: { alert: vi.fn() },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} },
}));
vi.mock('react-native-reanimated', () => {
  const animation = {
    damping() {
      return this;
    },
    stiffness() {
      return this;
    },
    mass() {
      return this;
    },
  };
  return {
    default: { View: ({ children }: Children) => createElement('div', null, children) },
    ZoomIn: { springify: () => animation },
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#111', fill: '#eee', error: '#c00' },
    brandColors: { error: '#c00' },
    variant: 'liquidGlass',
  }),
}));
vi.mock('../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 }, borderRadius: { xl: 20 } }));
vi.mock('../../theme/top-bar', () => ({ topBarFor: () => ({ labelMaxFontScale: 1.2 }) }));
vi.mock('../../theme/animations', () => ({ springs: { bouncy: { damping: 1, stiffness: 1, mass: 1 } } }));
vi.mock('../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../Icon', () => ({ Icon: () => null }));
vi.mock('../GlassSurface', () => ({ GlassSurface: () => null }));
vi.mock('../ValueSlider', () => ({ ValueSlider: () => null }));
vi.mock('../Button', () => ({ Button: () => null }));
vi.mock('../ChromeIconButton', () => ({ ChromeIconButton: () => null }));
vi.mock('../outline-editor/SprayCountCrossfade', () => ({
  SprayCountCrossfade: ({ text }: { text: string }) => createElement('span', null, text),
}));
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, disabled }: Children & { onPress?: () => void; disabled?: boolean }) =>
    createElement('button', { onClick: onPress, disabled }, children),
}));
// The native viewer's gesture is tested separately. This boundary delivers its
// activation event so these callers must preserve the real action and guards.
vi.mock('../LargeContentViewer', () => ({
  LargeContentViewer: ({ title, onActivate, children }: Children & { title: string; onActivate?: () => void }) =>
    createElement('span', { 'data-viewer-title': title, onContextMenu: onActivate }, children),
}));

import { QueueSheetHeader } from '../play-drawer/QueueSheetHeader';
import { SprayCountCapsule } from '../outline-editor/SprayCountCapsule';
import { SprayHoldChipBar } from '../outline-editor/SprayHoldChipBar';
afterEach(cleanup);
const viewer = (container: HTMLElement, title: string) => container.querySelector(`[data-viewer-title="${title}"]`)!;

it('clears once through the queue header viewer and does not run other header actions', () => {
  const clear = vi.fn();
  const other = vi.fn();
  const { container } = render(
    <QueueSheetHeader
      isEditMode
      showHistory={false}
      selectedCount={1}
      queueCount={2}
      viewOnlyMode={false}
      onToggleEditMode={other}
      onToggleHistory={other}
      onClose={other}
      onClearAll={clear}
    />,
  );
  fireEvent.contextMenu(viewer(container, 'queueDrawer.clear'));
  expect(clear).toHaveBeenCalledOnce();
  expect(other).not.toHaveBeenCalled();
});

it('opens the count menu once while unlocked and keeps locked or read-only counts inert', () => {
  const open = vi.fn();
  const props = {
    counts: { on: 2, off: 0, maybes: 0, unsavedWrites: 0, unsavedFinds: 0, unsavedRemovals: 0 },
    showMaybes: false,
    celebrating: false,
  };
  const { container, rerender } = render(<SprayCountCapsule {...props} locked={false} onPress={open} />);
  fireEvent.contextMenu(viewer(container, 'sprayEditor.bar.holds'));
  expect(open).toHaveBeenCalledOnce();
  rerender(<SprayCountCapsule {...props} locked onPress={open} />);
  fireEvent.contextMenu(viewer(container, 'sprayEditor.bar.holds'));
  rerender(<SprayCountCapsule {...props} locked={false} />);
  fireEvent.contextMenu(viewer(container, 'sprayEditor.bar.holds'));
  expect(open).toHaveBeenCalledOnce();
});

it('runs the matching hold action once and keeps unavailable size actions inert', () => {
  const remove = vi.fn();
  const shrink = vi.fn();
  const other = vi.fn();
  const props = {
    canShrink: false,
    canGrow: true,
    onShrink: shrink,
    onGrow: other,
    onSwitchOff: other,
    onSwitchOn: other,
    onDelete: remove,
  };
  const { container, rerender } = render(<SprayHoldChipBar {...props} role="off" />);
  fireEvent.contextMenu(viewer(container, 'sprayEditor.chips.delete'));
  expect(remove).toHaveBeenCalledOnce();
  expect(other).not.toHaveBeenCalled();
  rerender(<SprayHoldChipBar {...props} role="on" />);
  fireEvent.contextMenu(viewer(container, 'sprayEditor.a11y.actions.smaller'));
  expect(shrink).not.toHaveBeenCalled();
});
