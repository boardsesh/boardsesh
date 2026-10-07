// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const ctrl = vi.hoisted(() => ({ fontScale: 1, variant: 'liquidGlass' as 'liquidGlass' | 'material' }));

type ViewMockProps = { children?: ReactNode; style?: unknown; testID?: string };

/** Flattens a style that may be an object, an array of layers, or null. */
function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style != null && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: '26.1', select: (options: { ios?: unknown }) => options.ios },
  PlatformColor: (name: string) => name,
  View: ({ children, style, testID }: ViewMockProps) =>
    createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(flatten(style)) }, children),
  StyleSheet: {
    create: (sheet: Record<string, unknown>) => sheet,
    hairlineWidth: 1,
  },
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: ctrl.fontScale }),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => `t:${key}` }) }));

vi.mock('../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../test/theme-mock');
  const themes = { liquidGlass: makeThemeMock(), material: makeThemeMock({ variant: 'material' }) };
  return { useTheme: () => themes[ctrl.variant], useOptionalTheme: () => themes[ctrl.variant] };
});

type TextMockProps = { children?: ReactNode; style?: unknown; numberOfLines?: number; maxFontSizeMultiplier?: number };
vi.mock('../Text', () => ({
  Text: ({ children, style, numberOfLines, maxFontSizeMultiplier }: TextMockProps) =>
    createElement(
      'span',
      {
        'data-style': JSON.stringify(flatten(style)),
        'data-lines': numberOfLines,
        'data-max-scale': maxFontSizeMultiplier,
      },
      children,
    ),
}));

vi.mock('../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }),
}));

vi.mock('../ActivityIndicator', () => ({
  ActivityIndicator: () => createElement('progress', { 'data-spinner': 'true' }),
}));

type PressMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
};
vi.mock('../PressableSurface', () => ({
  // Like the real Pressable, a disabled surface does not fire onPress.
  PressableSurface: ({ children, onPress, disabled, testID, accessibilityLabel }: PressMockProps) =>
    createElement(
      'button',
      { 'data-testid': testID, 'aria-label': accessibilityLabel, disabled, onClick: () => onPress?.() },
      children,
    ),
}));

import { SheetTopBar } from '../SheetTopBar';

const styleOf = (element: Element | null) => JSON.parse(element?.getAttribute('data-style') ?? '{}');

describe('SheetTopBar', () => {
  beforeEach(() => {
    ctrl.fontScale = 1;
    ctrl.variant = 'liquidGlass';
  });

  it('renders the title, a Cancel leading action and the trailing label', () => {
    const onCancel = vi.fn();
    const onSave = vi.fn();
    const { getByText, getByTestId } = render(
      createElement(SheetTopBar, {
        title: 'Report climb',
        leading: { kind: 'cancel', onPress: onCancel },
        trailing: { label: 'Send', onPress: onSave, prominent: true },
      }),
    );
    expect(getByText('Report climb')).toBeTruthy();
    expect(getByText('t:actions.cancel')).toBeTruthy();
    fireEvent.click(getByTestId('sheet-top-bar-leading'));
    fireEvent.click(getByTestId('sheet-top-bar-trailing'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('draws an X for close and a back glyph for back, with spoken labels', () => {
    const close = render(createElement(SheetTopBar, { title: 'Wall', leading: { kind: 'close', onPress: vi.fn() } }));
    expect(close.container.querySelector('[data-icon="close"]')).not.toBeNull();
    expect(close.getByLabelText('t:ariaLabels.close')).toBeTruthy();

    const back = render(createElement(SheetTopBar, { title: 'Step 2', leading: { kind: 'back', onPress: vi.fn() } }));
    expect(back.container.querySelector('[data-icon="back"]')).not.toBeNull();
    expect(back.getByLabelText('t:ariaLabels.back')).toBeTruthy();
  });

  it('a text leading action shows its own label and swallows the tap while disabled', () => {
    const onReset = vi.fn();
    const enabled = render(
      createElement(SheetTopBar, { title: 'Filters', leading: { kind: 'text', label: 'Reset', onPress: onReset } }),
    );
    fireEvent.click(enabled.getByText('Reset'));
    expect(onReset).toHaveBeenCalledTimes(1);
    enabled.unmount();

    const disabled = render(
      createElement(SheetTopBar, {
        title: 'Filters',
        leading: { kind: 'text', label: 'Reset', onPress: onReset, disabled: true },
      }),
    );
    fireEvent.click(disabled.getByTestId('sheet-top-bar-leading'));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('a disabled trailing action swallows the tap', () => {
    const onSave = vi.fn();
    const { getByTestId } = render(
      createElement(SheetTopBar, { title: 'Edit', trailing: { label: 'Save', onPress: onSave, disabled: true } }),
    );
    fireEvent.click(getByTestId('sheet-top-bar-trailing'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('loading keeps the label in the slot, hidden under a spinner, and swallows the tap', () => {
    const onSave = vi.fn();
    const { getByText, getByTestId } = render(
      createElement(SheetTopBar, { title: 'Edit', trailing: { label: 'Save', onPress: onSave, loading: true } }),
    );
    // Still rendered, so the slot keeps the label's width and nothing moves.
    const label = getByText('Save');
    expect(JSON.parse(label.getAttribute('data-style') ?? '{}')).toMatchObject({ opacity: 0 });
    expect(JSON.parse(getByTestId('sheet-top-bar-spinner').getAttribute('data-style') ?? '{}')).toMatchObject({
      position: 'absolute',
    });
    fireEvent.click(getByTestId('sheet-top-bar-trailing'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('the label is fully visible when not loading', () => {
    const { getByText, queryByTestId } = render(
      createElement(SheetTopBar, { title: 'Edit', trailing: { label: 'Save', onPress: vi.fn() } }),
    );
    expect(JSON.parse(getByText('Save').getAttribute('data-style') ?? '{}').opacity).toBeUndefined();
    expect(queryByTestId('sheet-top-bar-spinner')).toBeNull();
  });

  it('reserves the error slot at the same height with and without an error', () => {
    const slotStyle = (error: string | null) => {
      const view = render(createElement(SheetTopBar, { title: 'Report', reserveErrorSlot: true, error }));
      const style = JSON.parse(view.getByTestId('sheet-top-bar-error-slot').getAttribute('data-style') ?? '{}');
      const shown = error ? view.queryByText(error) != null : false;
      view.unmount();
      return { style, shown };
    };
    const { style: emptySlot } = slotStyle(null);
    const { style: filledSlot, shown } = slotStyle('That did not send.');
    expect(emptySlot.height).toBeGreaterThan(0);
    expect(filledSlot.height).toBe(emptySlot.height);
    expect(shown).toBe(true);
  });

  it('has no error slot unless one is reserved or an error is shown', () => {
    const { queryByTestId } = render(createElement(SheetTopBar, { title: 'Pick a gym' }));
    expect(queryByTestId('sheet-top-bar-error-slot')).toBeNull();
  });

  it('the title yields to the actions: a long title beside "Speichern" at 1.2x never truncates the action', () => {
    ctrl.fontScale = 1.2;
    const { getByText, getByTestId } = render(
      createElement(SheetTopBar, {
        title: 'Eine sehr lange Überschrift für dieses Blatt, die nicht passt',
        leading: { kind: 'cancel', onPress: vi.fn() },
        trailing: { label: 'Speichern', onPress: vi.fn(), prominent: true },
      }),
    );
    // The flanks hold their width; only the title column can shrink.
    expect(styleOf(getByTestId('sheet-top-bar-trailing-flank'))).toMatchObject({ flexShrink: 0 });
    expect(styleOf(getByTestId('sheet-top-bar-leading-flank'))).toMatchObject({ flexShrink: 0 });
    const titleColumn = styleOf(getByTestId('sheet-top-bar-title'));
    expect(titleColumn).toMatchObject({ flexShrink: 1, minWidth: 0 });
    expect(titleColumn.maxWidth).toBeUndefined();
    // The action's label is whole, and capped so the 1.2x scale can't outgrow the bar.
    const label = getByText('Speichern');
    expect(label.textContent).toBe('Speichern');
    expect(label.getAttribute('data-max-scale')).toBe('1.2');
  });

  it('a prominent confirm is a filled capsule on Liquid Glass and plain text on Material', () => {
    const glass = render(
      createElement(SheetTopBar, { title: 'Edit', trailing: { label: 'Save', onPress: vi.fn(), prominent: true } }),
    );
    const glassFill = styleOf(glass.getByText('Save').parentElement).backgroundColor;
    glass.unmount();
    expect(glassFill).toBeTruthy();

    ctrl.variant = 'material';
    const material = render(
      createElement(SheetTopBar, { title: 'Edit', trailing: { label: 'Save', onPress: vi.fn(), prominent: true } }),
    );
    expect(styleOf(material.getByText('Save').parentElement).backgroundColor).toBeUndefined();
    expect(styleOf(material.getByText('Save'))).toMatchObject({ fontWeight: '600' });
  });

  it('draws the trailing accessory before the action', () => {
    const { getByTestId } = render(
      createElement(SheetTopBar, {
        title: 'Holds',
        trailingAccessory: createElement('em', { 'data-testid': 'help' }, '?'),
        trailing: { label: 'Next', onPress: vi.fn() },
      }),
    );
    const flank = getByTestId('sheet-top-bar-trailing-flank');
    expect(flank.firstElementChild?.getAttribute('data-testid')).toBe('help');
  });

  it('a long error at 2x font scale stays one line in a slot of fixed, capped height', () => {
    ctrl.fontScale = 2;
    const slotFor = (error: string | null) => {
      const view = render(createElement(SheetTopBar, { title: 'Report', reserveErrorSlot: true, error }));
      const style = styleOf(view.getByTestId('sheet-top-bar-error-slot'));
      const text = error ? view.getByText(error) : null;
      const lines = text?.getAttribute('data-lines');
      const maxScale = text?.getAttribute('data-max-scale');
      view.unmount();
      return { style, lines, maxScale };
    };
    const empty = slotFor(null);
    const long = slotFor('That did not send.'.repeat(10));
    // footnote 18pt x the 1.2 cap (not 2), plus 4pt padding top and bottom.
    expect(empty.style.height).toBe(Math.ceil(18 * 1.2) + 8);
    expect(long.style.height).toBe(empty.style.height);
    expect(long.style.overflow).toBe('hidden');
    expect(long.lines).toBe('1');
    expect(long.maxScale).toBe('1.2');
  });
});
