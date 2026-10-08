// @vitest-environment jsdom
// Native magnification has its own wrapper tests; keep bar-geometry assertions on the bar.
vi.mock('../LargeContentViewer', () => ({
  LargeContentViewer: ({ children }: { children: React.ReactNode }) => children,
}));
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
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
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

type TextMockProps = {
  children?: ReactNode;
  style?: unknown;
  color?: string;
  variant?: string;
  numberOfLines?: number;
  maxFontSizeMultiplier?: number;
};
vi.mock('../Text', () => ({
  Text: ({ children, style, color, variant, numberOfLines, maxFontSizeMultiplier }: TextMockProps) =>
    createElement(
      'span',
      {
        'data-style': JSON.stringify(flatten(style)),
        'data-color': color,
        'data-variant': variant,
        'data-lines': numberOfLines,
        'data-max-scale': maxFontSizeMultiplier,
      },
      children,
    ),
}));

vi.mock('../Icon', () => ({
  Icon: ({ name, size, color, weight }: { name: string; size?: number; color?: string; weight?: string }) =>
    createElement('i', { 'data-icon': name, 'data-size': size, 'data-color': color, 'data-weight': weight }),
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
  accessibilityHint?: string;
  style?: unknown;
};
vi.mock('../PressableSurface', () => ({
  // Like the real Pressable, a disabled surface does not fire onPress.
  PressableSurface: ({
    children,
    onPress,
    disabled,
    testID,
    accessibilityLabel,
    accessibilityHint,
    style,
  }: PressMockProps) =>
    createElement(
      'button',
      {
        'data-testid': testID,
        'aria-label': accessibilityLabel,
        'data-hint': accessibilityHint,
        'data-style': JSON.stringify(flatten(style)),
        disabled,
        onClick: () => onPress?.(),
      },
      children,
    ),
}));

import { SheetTopBar } from '../SheetTopBar';
import { makeThemeMock } from '../../test/theme-mock';

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

  it('a cancel leading action shows a custom word in place of Cancel', () => {
    const onDecline = vi.fn();
    const { getByText, queryByText, getByTestId } = render(
      createElement(SheetTopBar, {
        title: '',
        leading: { kind: 'cancel', label: 'Not now', onPress: onDecline },
      }),
    );
    expect(getByText('Not now')).toBeTruthy();
    expect(queryByText('t:actions.cancel')).toBeNull();
    expect(getByTestId('sheet-top-bar-leading').getAttribute('aria-label')).toBe('Not now');
    fireEvent.click(getByTestId('sheet-top-bar-leading'));
    expect(onDecline).toHaveBeenCalledTimes(1);
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

  it('paints the accent bar before a left-aligned title, and falls back to the separator tone', () => {
    const coloured = render(createElement(SheetTopBar, { title: 'Climb', accentColor: '#FF0000' }));
    const bar = styleOf(coloured.getByTestId('sheet-top-bar-accent'));
    expect(bar).toMatchObject({ width: 4, height: 32, backgroundColor: '#FF0000' });
    expect(bar.borderRadius).toBeDefined();
    expect(styleOf(coloured.getByText('Climb'))).toMatchObject({ textAlign: 'left' });
    coloured.unmount();

    const ungraded = render(createElement(SheetTopBar, { title: 'Climb', accentColor: null }));
    expect(styleOf(ungraded.getByTestId('sheet-top-bar-accent')).backgroundColor).toBeDefined();
    ungraded.unmount();

    const plain = render(createElement(SheetTopBar, { title: 'Climb' }));
    expect(plain.queryByTestId('sheet-top-bar-accent')).toBeNull();
    expect(styleOf(plain.getByText('Climb'))).toMatchObject({ textAlign: 'center' });
  });

  it('a disabled leading action swallows the tap, for every kind', () => {
    for (const kind of ['back', 'close', 'cancel'] as const) {
      const onLeave = vi.fn();
      const { getByTestId, unmount } = render(
        createElement(SheetTopBar, { title: 'Step 2', leading: { kind, onPress: onLeave, disabled: true } }),
      );
      expect(getByTestId('sheet-top-bar-leading').hasAttribute('disabled')).toBe(true);
      fireEvent.click(getByTestId('sheet-top-bar-leading'));
      expect(onLeave).not.toHaveBeenCalled();
      unmount();
    }
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
        trailing: { kind: 'forward', label: 'Speichern', onPress: vi.fn(), prominent: true },
      }),
    );
    // The flanks hold their width; only the title column can shrink.
    expect(styleOf(getByTestId('sheet-top-bar-trailing-flank'))).toMatchObject({ flexShrink: 0 });
    expect(styleOf(getByTestId('sheet-top-bar-leading-flank'))).toMatchObject({ flexShrink: 0 });
    const titleColumn = styleOf(getByTestId('sheet-top-bar-title'));
    expect(titleColumn).toMatchObject({ flexShrink: 1, minWidth: 0 });
    expect(titleColumn.maxWidth).toBeUndefined();
    // The action's label is whole, and held at 1x like a UIKit bar item, so the
    // 1.2x scale can't outgrow the bar.
    const label = getByText('Speichern');
    expect(label.textContent).toBe('Speichern');
    expect(label.getAttribute('data-max-scale')).toBe('1');
  });

  it('sets every action label in the label variant, held at 1x on iOS and 1.2x on Material', () => {
    const labelsOf = () =>
      render(
        createElement(SheetTopBar, {
          title: 'Edit',
          leading: { kind: 'cancel', onPress: vi.fn() },
          trailing: { kind: 'forward', label: 'Save', onPress: vi.fn(), prominent: true },
        }),
      );
    const glass = labelsOf();
    for (const text of ['t:actions.cancel', 'Save']) {
      expect(glass.getByText(text).getAttribute('data-variant')).toBe('label');
      expect(glass.getByText(text).getAttribute('data-max-scale')).toBe('1');
    }
    glass.unmount();
    ctrl.variant = 'material';
    const material = labelsOf();
    expect(material.getByText('Save').getAttribute('data-max-scale')).toBe('1.2');
  });

  it('Cancel and a plain confirm are in the label colour; only the prominent confirm takes the brand', () => {
    const { systemColors } = makeThemeMock();
    const { getByText } = render(
      createElement(SheetTopBar, {
        title: 'Edit',
        leading: { kind: 'cancel', onPress: vi.fn() },
        trailing: { label: 'Skip', onPress: vi.fn() },
      }),
    );
    expect(getByText('t:actions.cancel').getAttribute('data-color')).toBe(systemColors.label);
    expect(getByText('Skip').getAttribute('data-color')).toBe(systemColors.label);
  });

  it('the prominent forward capsule is 36pt tall, a full capsule, 14pt in from each side, with 17pt-600 text', () => {
    const { getByText } = render(
      createElement(SheetTopBar, {
        title: 'Edit',
        trailing: { kind: 'forward', label: 'Next', onPress: vi.fn(), prominent: true },
      }),
    );
    expect(styleOf(getByText('Next').parentElement)).toMatchObject({
      height: 36,
      borderRadius: 18,
      paddingHorizontal: 14,
    });
    expect(styleOf(getByText('Next'))).toMatchObject({ fontWeight: '600' });
  });

  it('a disabled capsule dims to 40% as a whole', () => {
    const { getByText } = render(
      createElement(SheetTopBar, {
        title: 'Edit',
        trailing: { kind: 'forward', label: 'Next', onPress: vi.fn(), prominent: true, disabled: true },
      }),
    );
    expect(styleOf(getByText('Next').parentElement)).toMatchObject({ opacity: 0.4 });
  });

  it('close is a 17pt label-coloured xmark in a 44pt fill circle; Material draws 24dp onSurface in 48 with no fill', () => {
    const { systemColors } = makeThemeMock();
    const glass = render(createElement(SheetTopBar, { title: 'Wall', leading: { kind: 'close', onPress: vi.fn() } }));
    const glyph = glass.container.querySelector('[data-icon="close"]');
    expect(glyph?.getAttribute('data-size')).toBe('17');
    expect(glyph?.getAttribute('data-color')).toBe(systemColors.label);
    expect(styleOf(glass.getByTestId('sheet-top-bar-leading'))).toMatchObject({
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: systemColors.fill,
    });
    glass.unmount();

    ctrl.variant = 'material';
    const materialTheme = makeThemeMock({ variant: 'material' });
    const material = render(
      createElement(SheetTopBar, { title: 'Wall', leading: { kind: 'close', onPress: vi.fn() } }),
    );
    const materialGlyph = material.container.querySelector('[data-icon="close"]');
    expect(materialGlyph?.getAttribute('data-size')).toBe('24');
    // A navigation icon: onSurface, which the Material theme resolves `label` to.
    expect(materialGlyph?.getAttribute('data-color')).toBe(materialTheme.systemColors.label);
    const materialTarget = styleOf(material.getByTestId('sheet-top-bar-leading'));
    expect(materialTarget).toMatchObject({ width: 48, height: 48 });
    expect(materialTarget.backgroundColor).toBeUndefined();
  });

  it('a prominent forward action is a filled capsule on Liquid Glass and plain text on Material', () => {
    const glass = render(
      createElement(SheetTopBar, {
        title: 'Edit',
        trailing: { kind: 'forward', label: 'Save', onPress: vi.fn(), prominent: true },
      }),
    );
    const glassFill = styleOf(glass.getByText('Save').parentElement).backgroundColor;
    glass.unmount();
    expect(glassFill).toBeTruthy();

    ctrl.variant = 'material';
    const material = render(
      createElement(SheetTopBar, {
        title: 'Edit',
        trailing: { kind: 'forward', label: 'Save', onPress: vi.fn(), prominent: true },
      }),
    );
    expect(styleOf(material.getByText('Save').parentElement).backgroundColor).toBeUndefined();
    // M3 labelLarge stays medium: brand text, no fill.
    expect(styleOf(material.getByText('Save'))).toMatchObject({ fontWeight: '500' });
  });

  it('a destructive action is never filled: the label is in the error colour', () => {
    const { brandColors } = makeThemeMock();
    const glass = render(
      createElement(SheetTopBar, {
        title: 'End',
        trailing: { kind: 'forward', label: 'End session', onPress: vi.fn(), prominent: true, destructive: true },
      }),
    );
    expect(styleOf(glass.getByText('End session').parentElement).backgroundColor).toBeUndefined();
    expect(glass.getByText('End session').getAttribute('data-color')).toBe(brandColors.error);
    glass.unmount();

    const plain = render(
      createElement(SheetTopBar, { title: 'End', trailing: { label: 'Leave', onPress: vi.fn(), destructive: true } }),
    );
    expect(plain.getByText('Leave').getAttribute('data-color')).toBe(brandColors.error);
    plain.unmount();

    ctrl.variant = 'material';
    const material = render(
      createElement(SheetTopBar, {
        title: 'End',
        trailing: { kind: 'confirm', label: 'End session', onPress: vi.fn(), prominent: true, destructive: true },
      }),
    );
    expect(styleOf(material.getByText('End session').parentElement).backgroundColor).toBeUndefined();
    expect(material.getByText('End session').getAttribute('data-color')).toBe(brandColors.error);
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

  it('iOS: a confirm is a ✓ in a 44pt brand circle, spoken by its label, with no visible word', () => {
    const { brandColors } = makeThemeMock();
    const onSave = vi.fn();
    const { container, getByLabelText, queryByText } = render(
      createElement(SheetTopBar, { title: 'Edit', trailing: { kind: 'confirm', label: 'Save', onPress: onSave } }),
    );
    const button = getByLabelText('Save');
    const glyph = container.querySelector('[data-icon="confirm"]');
    expect(glyph?.getAttribute('data-size')).toBe('17');
    // Semibold, like the X beside it.
    expect(glyph?.getAttribute('data-weight')).toBe('semibold');
    expect(glyph?.getAttribute('data-color')).toBe(brandColors.onPrimary);
    expect(styleOf(button)).toMatchObject({
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: brandColors.primary,
    });
    expect(queryByText('Save')).toBeNull();
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('iOS: a prominent action with no kind is a confirm (the ✓), so a caller that names none still gets it', () => {
    const { container } = render(
      createElement(SheetTopBar, { title: 'Edit', trailing: { label: 'Save', onPress: vi.fn(), prominent: true } }),
    );
    expect(container.querySelector('[data-icon="confirm"]')).not.toBeNull();
  });

  it('iOS confirm: disabled dims the circle to 40%, loading swaps the glyph for a spinner; destructive is red text, no ✓', () => {
    const { brandColors } = makeThemeMock();
    const disabled = render(
      createElement(SheetTopBar, {
        title: 'Edit',
        trailing: { kind: 'confirm', label: 'Save', onPress: vi.fn(), disabled: true },
      }),
    );
    expect(styleOf(disabled.getByLabelText('Save'))).toMatchObject({ opacity: 0.4 });
    disabled.unmount();

    const loading = render(
      createElement(SheetTopBar, {
        title: 'Edit',
        trailing: { kind: 'confirm', label: 'Save', onPress: vi.fn(), loading: true },
      }),
    );
    expect(loading.getByTestId('sheet-top-bar-spinner')).toBeTruthy();
    expect(loading.container.querySelector('[data-icon="confirm"]')).toBeNull();
    loading.unmount();

    const destructive = render(
      createElement(SheetTopBar, {
        title: 'End',
        trailing: { kind: 'confirm', label: 'End session', onPress: vi.fn(), destructive: true },
      }),
    );
    // No red ✓: the word, in the error colour, with no fill.
    expect(destructive.container.querySelector('[data-icon="confirm"]')).toBeNull();
    expect(destructive.getByText('End session').getAttribute('data-color')).toBe(brandColors.error);
    expect(styleOf(destructive.getByText('End session').parentElement).backgroundColor).toBeUndefined();
  });

  it('iOS confirm: a caller glyph (the lock) stands in for the ✓, and the hint is kept', () => {
    const { container, getByLabelText } = render(
      createElement(SheetTopBar, {
        title: 'New climb',
        trailing: { kind: 'confirm', label: 'Save', onPress: vi.fn(), icon: 'lock', accessibilityHint: 'Locked' },
      }),
    );
    expect(container.querySelector('[data-icon="lock"]')?.getAttribute('data-weight')).toBe('semibold');
    expect(container.querySelector('[data-icon="confirm"]')).toBeNull();
    expect(getByLabelText('Save').getAttribute('data-hint')).toBe('Locked');
  });

  it('a forward action is text, and a text action shows its glyph before the label', () => {
    const forward = render(
      createElement(SheetTopBar, { title: 'Step', trailing: { kind: 'forward', label: 'Next', onPress: vi.fn() } }),
    );
    expect(forward.getByText('Next')).toBeTruthy();
    expect(forward.container.querySelector('[data-icon="confirm"]')).toBeNull();
    forward.unmount();
    ctrl.variant = 'material';
    const locked = render(
      createElement(SheetTopBar, {
        title: 'New',
        trailing: { kind: 'confirm', label: 'Save', onPress: vi.fn(), icon: 'lock' },
      }),
    );
    expect(locked.getByTestId('sheet-top-bar-trailing-icon')).toBeTruthy();
    expect(locked.getByText('Save')).toBeTruthy();
  });

  it('Material: confirm and forward are both brand text, never the ✓', () => {
    ctrl.variant = 'material';
    const { brandColors } = makeThemeMock({ variant: 'material' });
    for (const kind of ['confirm', 'forward'] as const) {
      const view = render(
        createElement(SheetTopBar, {
          title: 'Edit',
          trailing: { kind, label: 'Save', onPress: vi.fn(), prominent: true },
        }),
      );
      expect(view.container.querySelector('[data-icon="confirm"]')).toBeNull();
      expect(view.getByText('Save').getAttribute('data-color')).toBe(brandColors.primary);
      expect(styleOf(view.getByText('Save'))).toMatchObject({ fontWeight: '500' });
      view.unmount();
    }
  });

  it('a send is prominent text (a brand capsule on iOS), never the ✓', () => {
    const { container, getByText } = render(
      createElement(SheetTopBar, {
        title: 'Report',
        trailing: { kind: 'send', label: 'Send report', onPress: vi.fn() },
      }),
    );
    expect(container.querySelector('[data-icon="confirm"]')).toBeNull();
    expect(styleOf(getByText('Send report'))).toMatchObject({ fontWeight: '600' });
    expect(styleOf(getByText('Send report').parentElement).height).toBe(36);
  });
});
