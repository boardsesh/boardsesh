// @vitest-environment jsdom
//
// The guard on the shape that shipped #4642: an Android tick note rendered as a
// ~5pt sliver of glyph bottoms. Nothing in JS can observe the native padding
// injection that caused it, so this file pins the two JS-observable
// preconditions the fix rests on — the flat single-input shape, and the
// input declaring its own vertical padding — plus the arithmetic that one line
// of `subheadline` actually fits between them.
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { flattenStyle } from '../../../../test/flatten-style';

type TextInputMockProps = {
  style?: unknown;
  multiline?: boolean;
  placeholder?: string;
  accessibilityLabel?: string;
  value?: string;
};

vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default },
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-style': JSON.stringify(style ?? null) }, children),
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  BottomSheetTextInput: ({ style, multiline, placeholder, accessibilityLabel, value }: TextInputMockProps) =>
    createElement('textarea', {
      'data-style': JSON.stringify(style ?? null),
      'data-multiline': multiline ? 'true' : 'false',
      'data-placeholder': placeholder,
      'data-a11y-label': accessibilityLabel,
      'data-value': value,
    }),
}));

vi.mock('../../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../../test/theme-mock');
  const theme = makeThemeMock({ variant: 'material', colorScheme: 'dark' });
  return { useTheme: () => theme };
});

import { TickNoteField } from '../TickNoteField';
import { materialTextStyles } from '../../../theme/typography';

function renderField() {
  return render(
    createElement(TickNoteField, {
      value: '',
      onChangeText: vi.fn(),
      placeholder: 'How did it go?',
      accessibilityLabel: 'Note',
    }),
  );
}

/** The input's own flattened style — the array it is handed, resolved. */
function inputStyle(container: HTMLElement): Record<string, unknown> {
  const input = container.querySelector('textarea');
  expect(input).not.toBeNull();
  return flattenStyle(JSON.parse(input?.getAttribute('data-style') ?? 'null'));
}

describe('TickNoteField', () => {
  it('renders the input as its own root, with no wrapper element around it', () => {
    // The 2.3.1 shape was a bordered `View` wrapping a `flex: 1` input, and the
    // outer box's `justifyContent: 'center'` is what pinned the input to a
    // 26pt content box it could not grow out of. Re-adding a wrapper here
    // rebuilds that trap, so the root element IS the input.
    const { container } = renderField();

    expect(container.firstElementChild?.tagName).toBe('TEXTAREA');
    expect(container.querySelectorAll('div')).toHaveLength(0);
    expect(container.querySelectorAll('textarea')).toHaveLength(1);
  });

  it('declares its own vertical padding, which Android needs', () => {
    // Load-bearing, not decoration. `AndroidTextInputComponentDescriptor.h:98-102`
    // writes the theme's default EditText padding (~10pt top + ~10pt bottom)
    // into the Yoga style of any TextInput that declares none:
    //
    //   if (!props.hasPadding && !props.hasPaddingTop && !props.hasPaddingVertical) {
    //     style.setPadding(yoga::Edge::Top, points(theme.top));
    //   }
    //
    // Declaring padding here sets `hasPaddingVertical` and suppresses that
    // default. Drop it and the ~5pt sliver of #4642 comes back. Do not "tidy"
    // this away because iOS looks fine without it.
    const { container } = renderField();
    const style = inputStyle(container);

    expect(totalVerticalPaddingOf(style)).toBeGreaterThan(0);
  });

  it('leaves room for a full line of subheadline inside its resting height', () => {
    // The property the fix actually established: content box =
    // minHeight - 2*paddingVertical - 2*borderWidth must clear one rendered
    // line. Green today at 44 - 16 - 2 = 26 against a 20pt line box; red the
    // moment someone shaves the minimum or fattens the padding.
    const { container } = renderField();
    const style = inputStyle(container);

    const minHeight = Number(style.minHeight);
    const borderWidth = Number(style.borderWidth ?? 0);
    const contentHeight = minHeight - totalVerticalPaddingOf(style) - 2 * borderWidth;

    expect(contentHeight).toBeGreaterThanOrEqual(materialTextStyles.subheadline.lineHeight);
  });

  it('grows past its resting height before it starts hiding text', () => {
    // #4642's second half: past `maxHeight` the note scrolls inside the field,
    // and an Android multiline TextInput draws no scrollbar — so the start of
    // the note disappears with nothing on screen to say so. Four lines was too
    // few to be rare. Keep the ceiling at eight lines or better.
    const { container } = renderField();
    const style = inputStyle(container);

    const maxHeight = Number(style.maxHeight);
    const borderWidth = Number(style.borderWidth ?? 0);
    const visibleLines = Math.floor(
      (maxHeight - totalVerticalPaddingOf(style) - 2 * borderWidth) / materialTextStyles.subheadline.lineHeight,
    );

    expect(maxHeight).toBeGreaterThan(Number(style.minHeight));
    expect(visibleLines).toBeGreaterThanOrEqual(8);
    expect(style.textAlignVertical).toBe('top');
    expect(container.querySelector('textarea')?.getAttribute('data-multiline')).toBe('true');
  });
});

/** Top + bottom padding, however it was spelled: `paddingVertical`, `padding`,
 *  or a `paddingTop`/`paddingBottom` pair. Any of the three sets Fabric's
 *  `hasPadding*` flags and suppresses the injected theme default. Returns the
 *  sum rather than one edge, so the arithmetic below holds even if the two
 *  edges ever differ — and so this helper never asserts on the caller's behalf. */
function totalVerticalPaddingOf(style: Record<string, unknown>): number {
  if (style.paddingVertical != null) return 2 * Number(style.paddingVertical);
  if (style.paddingTop != null || style.paddingBottom != null) {
    return Number(style.paddingTop ?? 0) + Number(style.paddingBottom ?? 0);
  }
  if (style.padding != null) return 2 * Number(style.padding);
  return 0;
}
