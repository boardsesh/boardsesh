// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { AppMenuAction } from '../../AppMenu.types';
import { topBarByVariant } from '../../../theme/top-bar';

// The queue sheet's resting header carries a ⋯ menu with Clear queue (#7205's
// native menu). Clear used to live only behind the pencil, where climbers did
// not find it. These pin who sees it, what it runs and that it keeps the header's
// 44pt (48dp) glyph targets.

type Children = { children?: ReactNode };
const theme = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));

vi.mock('react-native', () => ({
  View: ({ children }: Children) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#111', secondaryLabel: '#666', fill: '#eee', error: '#c00' },
    brandColors: { primary: '#80f' },
    variant: theme.variant,
  }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../Text', () => ({
  Text: ({ children, numberOfLines }: Children & { numberOfLines?: number }) =>
    createElement('span', { 'data-lines': numberOfLines === undefined ? 'any' : String(numberOfLines) }, children),
}));
vi.mock('../../LargeContentViewer', () => ({
  LargeContentViewer: ({ children }: Children) => createElement('span', null, children),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    accessibilityLabel,
  }: Children & { onPress?: () => void; accessibilityLabel?: string }) =>
    createElement('button', { onClick: onPress, 'data-label': accessibilityLabel }, children),
}));
vi.mock('../../ChromeIconButton', () => ({
  ChromeIconButton: ({ onPress, accessibilityLabel }: { onPress: () => void; accessibilityLabel: string }) =>
    createElement('button', { onClick: onPress, 'data-label': accessibilityLabel }),
}));
// The native menu as data: the anchor's name, look and size, then one button per
// row that refuses a disabled row the way all three platform menus do.
vi.mock('../../AppMenu', () => ({
  AppMenu: ({
    actions,
    onSelectIndex,
    accessibilityLabel,
    iconName,
    iconAppearance,
    anchorSize,
  }: {
    actions: AppMenuAction[];
    onSelectIndex: (index: number) => void;
    accessibilityLabel: string;
    iconName: string;
    iconAppearance?: 'filled' | 'plain';
    anchorSize?: number;
  }) =>
    createElement(
      'div',
      {
        'data-testid': 'queue-menu',
        'data-label': accessibilityLabel,
        'data-icon': iconName,
        'data-appearance': iconAppearance ?? 'filled',
        'data-anchor-size': String(anchorSize),
      },
      ...actions.map((action, index) =>
        createElement('button', {
          key: action.label,
          'data-row': action.label,
          'data-destructive': String(Boolean(action.destructive)),
          'data-disabled': String(Boolean(action.disabled)),
          onClick: () => {
            if (!action.disabled) onSelectIndex(index);
          },
        }),
      ),
    ),
}));

import { QueueSheetHeader } from '../QueueSheetHeader';

afterEach(() => {
  cleanup();
  theme.variant = 'liquidGlass';
});

function renderHeader(overrides: Partial<Parameters<typeof QueueSheetHeader>[0]> = {}) {
  const handlers = {
    onClearAll: vi.fn(),
    onToggleEditMode: vi.fn(),
    onToggleHistory: vi.fn(),
    onClose: vi.fn(),
  };
  const view = render(
    <QueueSheetHeader
      isEditMode={false}
      showHistory={false}
      selectedCount={0}
      queueCount={3}
      viewOnlyMode={false}
      {...handlers}
      {...overrides}
    />,
  );
  return { ...view, handlers };
}

const pencil = (container: HTMLElement) => container.querySelector('[data-label="mobile.queueSheet.editQueue"]');
const menu = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-testid="queue-menu"]');

describe('QueueSheetHeader ⋯ menu', () => {
  it('offers Clear queue as one destructive row and clears from the menu, nothing else', () => {
    const { container, handlers } = renderHeader();
    const anchor = menu(container);
    expect(anchor?.getAttribute('data-label')).toBe('mobile.queueSheet.moreActions');
    expect(anchor?.getAttribute('data-icon')).toBe('more');
    const row = container.querySelector<HTMLElement>('[data-row="mobile.queueSheet.clearQueue"]');
    expect(row?.getAttribute('data-destructive')).toBe('true');
    expect(row?.getAttribute('data-disabled')).toBe('false');

    fireEvent.click(row!);
    expect(handlers.onClearAll).toHaveBeenCalledOnce();
    expect(handlers.onClearAll).toHaveBeenCalledWith('menu');
    expect(handlers.onToggleEditMode).not.toHaveBeenCalled();
    expect(handlers.onToggleHistory).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it('shows the ⋯ exactly when the pencil shows: an empty queue gets neither', () => {
    const withQueue = renderHeader();
    expect(pencil(withQueue.container)).not.toBeNull();
    expect(menu(withQueue.container)).not.toBeNull();
    cleanup();

    const empty = renderHeader({ viewOnlyMode: true, queueCount: 0 });
    expect(pencil(empty.container)).toBeNull();
    expect(menu(empty.container)).toBeNull();
    expect(empty.container.querySelector('[data-row="mobile.queueSheet.clearQueue"]')).toBeNull();
  });

  it('keeps the side panel ⋯ (no title, no close) with the same Clear queue', () => {
    const { container, handlers } = renderHeader({ showTitle: false, onClose: undefined });
    fireEvent.click(container.querySelector('[data-row="mobile.queueSheet.clearQueue"]')!);
    expect(handlers.onClearAll).toHaveBeenCalledWith('menu');
  });

  it.each(['liquidGlass', 'material'] as const)(
    'sizes and fills the ⋯ like the glyph buttons beside it on %s',
    (variant) => {
      theme.variant = variant;
      const spec = topBarByVariant[variant];
      const { container } = renderHeader();
      const anchor = menu(container);
      expect(anchor?.getAttribute('data-anchor-size')).toBe(String(spec.iconTarget));
      expect(anchor?.getAttribute('data-appearance')).toBe(spec.glyphFilled ? 'filled' : 'plain');
    },
  );

  it('keeps the title and count on one line now three buttons share the trailing side', () => {
    const { getByText } = renderHeader();
    expect(getByText('queueDrawer.title').getAttribute('data-lines')).toBe('1');
    expect(getByText('mobile.queue.climbCount').getAttribute('data-lines')).toBe('1');
  });

  it('leaves the ⋯ out of the edit mode, whose own Clear still clears as edit', () => {
    const { container, handlers } = renderHeader({ isEditMode: true, selectedCount: 1 });
    expect(menu(container)).toBeNull();
    fireEvent.click(container.querySelector('[data-label="queueDrawer.clear"]')!);
    expect(handlers.onClearAll).toHaveBeenCalledOnce();
    expect(handlers.onClearAll).toHaveBeenCalledWith('edit');
  });
});
