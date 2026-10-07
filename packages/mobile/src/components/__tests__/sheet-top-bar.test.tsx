// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

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
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => `t:${key}` }) }));

vi.mock('../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../test/theme-mock');
  const theme = makeThemeMock();
  return { useTheme: () => theme, useOptionalTheme: () => theme };
});

vi.mock('../Text', () => ({
  Text: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('span', { 'data-style': JSON.stringify(flatten(style)) }, children),
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

describe('SheetTopBar', () => {
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
    expect(emptySlot.minHeight).toBeGreaterThan(0);
    expect(filledSlot.minHeight).toBe(emptySlot.minHeight);
    expect(shown).toBe(true);
  });

  it('has no error slot unless one is reserved or an error is shown', () => {
    const { queryByTestId } = render(createElement(SheetTopBar, { title: 'Pick a gym' }));
    expect(queryByTestId('sheet-top-bar-error-slot')).toBeNull();
  });

  it('gives each flank an equal share so the title stays centred', () => {
    const { container } = render(
      createElement(SheetTopBar, {
        title: 'Edit',
        leading: { kind: 'cancel', onPress: vi.fn() },
        trailing: { label: 'Save changes', onPress: vi.fn() },
      }),
    );
    const flanks = [...container.querySelectorAll('div[data-style]')]
      .map((node) => JSON.parse(node.getAttribute('data-style') ?? '{}'))
      .filter((style) => style.flexBasis === 0);
    expect(flanks).toHaveLength(2);
    expect(flanks[0].flexGrow).toBe(flanks[1].flexGrow);
  });
});
