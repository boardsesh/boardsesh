// @vitest-environment jsdom
// Native magnification has its own wrapper tests; keep bar-geometry assertions on the bar.
vi.mock('../LargeContentViewer', () => ({
  LargeContentViewer: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../AccessibleTextInput', async () => {
  const { TextInput } = await import('react-native');
  return { AccessibleTextInput: TextInput };
});
vi.mock('../../hooks/use-bold-text', () => ({ useBoldText: () => false }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style != null && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: '26.1', select: (options: { ios?: unknown }) => options.ios },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  View: ({ children, style, testID }: { children?: ReactNode; style?: unknown; testID?: string }) =>
    createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(flatten(style)) }, children),
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (sheet: Record<string, unknown>) => sheet,
    hairlineWidth: 1,
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => `t:${key}` }) }));

vi.mock('../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../test/theme-mock');
  const themes = { liquidGlass: makeThemeMock(), material: makeThemeMock({ variant: 'material' }) };
  return { useTheme: () => themes[ctrl.variant], useOptionalTheme: () => themes[ctrl.variant] };
});

vi.mock('../Text', () => ({
  Text: ({
    children,
    style,
    color,
    variant,
    maxFontSizeMultiplier,
  }: {
    children?: ReactNode;
    style?: unknown;
    color?: string;
    variant?: string;
    maxFontSizeMultiplier?: number;
  }) =>
    createElement(
      'span',
      {
        'data-style': JSON.stringify(flatten(style)),
        'data-color': color,
        'data-variant': variant,
        'data-max-scale': maxFontSizeMultiplier,
      },
      children,
    ),
}));

vi.mock('../Icon', () => ({
  Icon: ({ name, size, color }: { name: string; size?: number; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-size': size, 'data-color': color }),
}));

vi.mock('../ActivityIndicator', () => ({
  ActivityIndicator: ({ color }: { color?: string }) => createElement('progress', { 'data-color': color }),
}));

vi.mock('../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    disabled,
    testID,
    accessibilityLabel,
    hitSlop,
    style,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
    accessibilityLabel?: string;
    hitSlop?: number;
    style?: unknown;
  }) =>
    createElement(
      'button',
      {
        'data-testid': testID,
        'aria-label': accessibilityLabel,
        'data-hit-slop': hitSlop,
        'data-style': JSON.stringify(flatten(style)),
        disabled,
        onClick: () => onPress?.(),
      },
      children,
    ),
}));

import { HeaderLeadingButton, HeaderTrailingButton } from '../HeaderActionButtons';
import { makeThemeMock } from '../../test/theme-mock';

const styleOf = (element: Element | null) => JSON.parse(element?.getAttribute('data-style') ?? '{}');

describe('HeaderLeadingButton', () => {
  beforeEach(() => {
    ctrl.variant = 'liquidGlass';
  });

  it('a native-header X is a bare 17pt label-coloured glyph that UIKit wraps in glass, with a 44pt target', () => {
    const { systemColors } = makeThemeMock();
    const onClose = vi.fn();
    const { container, getByTestId } = render(
      createElement(HeaderLeadingButton, { kind: 'close', onPress: onClose, accessibilityLabel: 'Close' }),
    );
    const glyph = container.querySelector('[data-icon="close"]');
    expect(glyph?.getAttribute('data-size')).toBe('17');
    expect(glyph?.getAttribute('data-color')).toBe(systemColors.label);
    const target = getByTestId('header-leading-action');
    // A 32pt frame plus 6pt of slop each side is the 44pt target; no fill of its own.
    expect(styleOf(target)).toMatchObject({ width: 32, height: 32 });
    expect(styleOf(target).backgroundColor).toBeUndefined();
    expect(target.getAttribute('data-hit-slop')).toBe('6');
    fireEvent.click(target);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Material: a 24dp onSurface navigation glyph in a 48dp target', () => {
    ctrl.variant = 'material';
    const { systemColors } = makeThemeMock({ variant: 'material' });
    const { container, getByTestId } = render(createElement(HeaderLeadingButton, { kind: 'back', onPress: vi.fn() }));
    const glyph = container.querySelector('[data-icon="back"]');
    expect(glyph?.getAttribute('data-size')).toBe('24');
    // M3 draws the navigation icon in onSurface (the Material `label`).
    expect(glyph?.getAttribute('data-color')).toBe(systemColors.label);
    expect(styleOf(getByTestId('header-leading-action'))).toMatchObject({ width: 48, height: 48 });
  });

  it('Cancel is label-coloured text in the label variant, held at 1x', () => {
    const { systemColors } = makeThemeMock();
    const { getByText } = render(createElement(HeaderLeadingButton, { kind: 'cancel', onPress: vi.fn() }));
    const label = getByText('t:actions.cancel');
    expect(label.getAttribute('data-variant')).toBe('label');
    expect(label.getAttribute('data-color')).toBe(systemColors.label);
    expect(label.getAttribute('data-max-scale')).toBe('1');
  });
});

describe('HeaderTrailingButton', () => {
  beforeEach(() => {
    ctrl.variant = 'liquidGlass';
  });

  it('a prominent forward action is brand 600 text with no capsule (UIKit draws the glass)', () => {
    const { brandColors } = makeThemeMock();
    const { getByText } = render(
      createElement(HeaderTrailingButton, { kind: 'forward', label: 'Next', onPress: vi.fn(), prominent: true }),
    );
    const label = getByText('Next');
    expect(label.getAttribute('data-variant')).toBe('label');
    expect(label.getAttribute('data-color')).toBe(brandColors.primary);
    expect(styleOf(label)).toMatchObject({ fontWeight: '600' });
    expect(styleOf(label.parentElement).backgroundColor).toBeUndefined();
  });

  it('a plain action is in the label colour, regular weight', () => {
    const { systemColors } = makeThemeMock();
    const { getByText } = render(createElement(HeaderTrailingButton, { label: 'Clear all', onPress: vi.fn() }));
    const label = getByText('Clear all');
    expect(label.getAttribute('data-color')).toBe(systemColors.label);
    expect(styleOf(label).fontWeight).toBeUndefined();
  });

  it('disabled dims to 40% and swallows the tap; loading spins in the label colour', () => {
    const { brandColors } = makeThemeMock();
    const onSave = vi.fn();
    const disabled = render(
      createElement(HeaderTrailingButton, {
        kind: 'forward',
        label: 'Save',
        onPress: onSave,
        prominent: true,
        disabled: true,
      }),
    );
    expect(styleOf(disabled.getByText('Save'))).toMatchObject({ opacity: 0.4 });
    fireEvent.click(disabled.getByTestId('header-trailing-action'));
    expect(onSave).not.toHaveBeenCalled();
    disabled.unmount();

    const loading = render(
      createElement(HeaderTrailingButton, {
        kind: 'forward',
        label: 'Save',
        onPress: onSave,
        prominent: true,
        loading: true,
      }),
    );
    expect(loading.container.querySelector('progress')?.getAttribute('data-color')).toBe(brandColors.primary);
    expect(styleOf(loading.getByText('Save'))).toMatchObject({ opacity: 0 });
  });

  it('Material: brand 14/500 text at 1.2x, disabled in onSurface at 38%', () => {
    ctrl.variant = 'material';
    const { systemColors } = makeThemeMock({ variant: 'material' });
    const { getByText } = render(
      createElement(HeaderTrailingButton, { label: 'Save', onPress: vi.fn(), prominent: true, disabled: true }),
    );
    const label = getByText('Save');
    expect(label.getAttribute('data-max-scale')).toBe('1.2');
    expect(label.getAttribute('data-color')).toBe(systemColors.label);
    expect(styleOf(label)).toMatchObject({ fontWeight: '500', opacity: 0.38 });
  });

  it('inside UIKit’s glass (before iOS 26) a confirm is brand 600 text, never a circle in the capsule', () => {
    const { brandColors } = makeThemeMock();
    const { container, getByText } = render(
      createElement(HeaderTrailingButton, { kind: 'confirm', label: 'Done', onPress: vi.fn() }),
    );
    expect(container.querySelector('[data-icon="confirm"]')).toBeNull();
    expect(getByText('Done').getAttribute('data-color')).toBe(brandColors.primary);
    expect(styleOf(getByText('Done'))).toMatchObject({ fontWeight: '600' });
  });

  it('standalone (iOS 26, glass hidden) a confirm is the 44pt brand ✓ circle, spoken by its label', () => {
    const { brandColors } = makeThemeMock();
    const { container, getByLabelText, queryByText } = render(
      createElement(HeaderTrailingButton, { kind: 'confirm', label: 'Done', onPress: vi.fn(), standalone: true }),
    );
    const button = getByLabelText('Done');
    expect(container.querySelector('[data-icon="confirm"]')?.getAttribute('data-color')).toBe(brandColors.onPrimary);
    expect(styleOf(button)).toMatchObject({ width: 44, height: 44, backgroundColor: brandColors.primary });
    expect(queryByText('Done')).toBeNull();
  });

  it('standalone, a prominent forward action is a 44pt brand capsule', () => {
    const { brandColors } = makeThemeMock();
    const { getByText } = render(
      createElement(HeaderTrailingButton, {
        kind: 'forward',
        label: 'Next',
        onPress: vi.fn(),
        prominent: true,
        standalone: true,
      }),
    );
    expect(styleOf(getByText('Next').parentElement)).toMatchObject({
      height: 44,
      backgroundColor: brandColors.primary,
    });
  });

  it('Material: a confirm is the word, not the ✓', () => {
    ctrl.variant = 'material';
    const { container, getByText } = render(
      createElement(HeaderTrailingButton, { kind: 'confirm', label: 'Save', onPress: vi.fn() }),
    );
    expect(container.querySelector('[data-icon="confirm"]')).toBeNull();
    expect(getByText('Save')).toBeTruthy();
  });
});
