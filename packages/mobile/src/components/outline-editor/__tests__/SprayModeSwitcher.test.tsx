// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import enUSCatalog from '../../../../../shared/i18n/locales/en-US/boards.json';
import type { SprayEditorMode } from '../spray-editor-mode';

vi.mock('react-native', () => ({
  StyleSheet: { absoluteFill: {}, hairlineWidth: 1, create: (styles: unknown) => styles },
  View: ({
    children,
    testID,
    accessibilityRole,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityRole?: string;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'div',
      { 'data-testid': testID, role: accessibilityRole, 'aria-label': accessibilityLabel },
      children,
    ),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#eee', label: '#000', secondaryLabel: '#555', elevatedSurface: '#fff' },
  }),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));
vi.mock('../../GlassSurface', () => ({ GlassSurface: () => null }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    testID,
    accessibilityRole,
    accessibilityLabel,
    accessibilityHint,
    accessibilityState,
    disabled,
    onPress,
    onLongPress,
    onPressOut,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityRole?: string;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityState?: { selected?: boolean; disabled?: boolean };
    disabled?: boolean;
    onPress?: () => void;
    onLongPress?: () => void;
    onPressOut?: () => void;
  }) =>
    createElement(
      'button',
      {
        'data-testid': testID,
        role: accessibilityRole,
        'aria-label': accessibilityLabel,
        'aria-description': accessibilityHint,
        'aria-selected': accessibilityState?.selected,
        'aria-disabled': accessibilityState?.disabled,
        disabled,
        onClick: onPress,
        // A press and hold, and the finger lifting.
        onMouseDown: onLongPress,
        onMouseUp: onPressOut,
      },
      children,
    ),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../../theme/layout', () => ({ glassSize: { standard: 48, capsule: 44, mini: 32 } }));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2 }));
import { SprayModeSwitcher, sprayModeCopy } from '../SprayModeSwitcher';

function mount(mode: SprayEditorMode, disabled = false) {
  const onChange = vi.fn();
  const view = render(createElement(SprayModeSwitcher, { mode, onChange, disabled }));
  return { ...view, onChange };
}

describe('SprayModeSwitcher', () => {
  it('is one toolbar of five buttons, in the switcher order', () => {
    const { getByRole } = mount('select');
    const toolbar = getByRole('toolbar');
    expect(toolbar.getAttribute('aria-label')).toBe('sprayEditor.modes.label');
    const labels = Array.from(toolbar.querySelectorAll('button')).map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual([
      'sprayEditor.modes.select',
      'sprayEditor.modes.add',
      'sprayEditor.modes.trace',
      'sprayEditor.modes.refine',
      'sprayEditor.modes.join',
    ]);
  });

  it('marks only the mode that is on as selected', () => {
    const { getByTestId } = mount('refine');
    expect(getByTestId('spray-mode-refine').getAttribute('aria-selected')).toBe('true');
    for (const other of ['select', 'add', 'trace', 'join']) {
      expect(getByTestId(`spray-mode-${other}`).getAttribute('aria-selected')).toBe('false');
    }
  });

  it('gives every segment a hint saying what the mode does', () => {
    const { getByTestId } = mount('select');
    expect(getByTestId('spray-mode-trace').getAttribute('aria-description')).toBe('sprayEditor.modes.hints.trace');
    expect(getByTestId('spray-mode-join').getAttribute('aria-description')).toBe('sprayEditor.modes.hints.join');
  });

  it('asks for the tapped mode', () => {
    const { getByTestId, onChange } = mount('select');
    fireEvent.click(getByTestId('spray-mode-trace'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('trace');
  });

  it('goes back to Select when the mode that is on is tapped again', () => {
    const { getByTestId, onChange } = mount('join');
    fireEvent.click(getByTestId('spray-mode-join'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('select');
  });

  it('does nothing for a tap on Select while Select is on', () => {
    const { getByTestId, onChange } = mount('select');
    fireEvent.click(getByTestId('spray-mode-select'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('disables every segment while the wall is locked', () => {
    const { getByRole } = mount('add', true);
    const buttons = Array.from(getByRole('toolbar').querySelectorAll('button'));
    expect(buttons).toHaveLength(5);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-disabled')).toBe('true');
    }
  });

  it('shows a held segment’s name above the capsule until the finger lifts', () => {
    const { getByTestId, queryByText, onChange } = mount('select');
    fireEvent.mouseDown(getByTestId('spray-mode-refine'));
    expect(queryByText('sprayEditor.modes.refine')).toBeTruthy();
    fireEvent.mouseUp(getByTestId('spray-mode-refine'));
    expect(queryByText('sprayEditor.modes.refine')).toBeNull();
    // Showing the name is not choosing the mode.
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('sprayModeCopy', () => {
  it('reads every mode’s name and hint from keys the catalogue has', () => {
    const modes = enUSCatalog.sprayEditor.modes;
    const translate = (key: string) => {
      const path = key.replace('sprayEditor.modes.', '').split('.');
      let node: unknown = modes;
      for (const segment of path) node = (node as Record<string, unknown>)[segment];
      return typeof node === 'string' ? node : `missing:${key}`;
    };
    for (const mode of ['select', 'add', 'trace', 'refine', 'join'] as const) {
      const copy = sprayModeCopy(mode, translate);
      expect(copy.label).not.toContain('missing');
      expect(copy.hint).not.toContain('missing');
    }
    expect(sprayModeCopy('trace', translate).label).toBe('Trace');
  });
});
