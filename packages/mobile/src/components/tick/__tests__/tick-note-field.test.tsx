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

  it('opens with room for two lines of subheadline, never fewer than one', () => {
    // Two invariants in one, and they are not the same invariant.
    //
    // The floor — content box clears ONE rendered line — is the property
    // #4684's fix established, and the one that failed in 2.3.1. It must hold
    // whatever the resting height becomes.
    //
    // The target — it clears TWO — is #4642's other half: a beta note that
    // opens one line tall gives the climber a word's worth of room to start a
    // sentence in. Green today at 64 - 16 - 2 = 46 against a 20pt line box.
    const { container } = renderField();
    const style = inputStyle(container);

    // Ahead of the arithmetic, because `minHeight` living on a wrapper instead
    // of the input (the 2.3.1 shape) makes every number below `NaN`, and
    // "expected NaN to be >= 40" names the symptom rather than the cause.
    expect(style.minHeight).toBeTypeOf('number');

    const minHeight = Number(style.minHeight);
    const borderWidth = Number(style.borderWidth ?? 0);
    const contentHeight = minHeight - totalVerticalPaddingOf(style) - 2 * borderWidth;
    const { lineHeight } = materialTextStyles.subheadline;

    expect(contentHeight).toBeGreaterThanOrEqual(lineHeight);
    expect(contentHeight).toBeGreaterThanOrEqual(2 * lineHeight);
  });

  it('draws a visible edge before it is focused', () => {
    // `transparent` at rest left the field with no boundary at all, so it read
    // as decoration rather than somewhere to type. The contrast that border
    // reaches is a separate, tracked problem (#4722); that it EXISTS is this
    // one. `borderWidth` stays put either way so focus never resizes the box.
    const { container } = renderField();
    const style = inputStyle(container);

    expect(style.borderColor).not.toBe('transparent');
    expect(style.borderColor).toBeTruthy();
    expect(Number(style.borderWidth)).toBeGreaterThan(0);
  });

  it('grows past its resting height before it starts hiding text', () => {
    // #4642's second half: past `maxHeight` the note scrolls inside the field,
    // and an Android multiline TextInput draws no scrollbar — so the start of
    // the note disappears with nothing on screen to say so. Four lines was too
    // few to be rare. Seven is the ceiling, and it is bounded from above too:
    // iOS keeps only 162pt of sheet body above the keyboard, and a field taller
    // than that can never scroll fully into view (see `TickNoteField`).
    const { container } = renderField();
    const style = inputStyle(container);

    // Same reason as the resting-height test: without this the regression
    // reports `NaN`, not "the ceiling moved off the input".
    expect(style.maxHeight).toBeTypeOf('number');

    const maxHeight = Number(style.maxHeight);
    const borderWidth = Number(style.borderWidth ?? 0);
    const visibleLines = Math.floor(
      (maxHeight - totalVerticalPaddingOf(style) - 2 * borderWidth) / materialTextStyles.subheadline.lineHeight,
    );

    expect(maxHeight).toBeGreaterThan(Number(style.minHeight));
    expect(visibleLines).toBeGreaterThanOrEqual(7);
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
