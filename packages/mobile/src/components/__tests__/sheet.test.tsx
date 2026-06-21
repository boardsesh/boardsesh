// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, createRef, forwardRef, type ComponentType, type ReactNode, type Ref } from 'react';

// RN style arrays merge later-wins, so the effective paddingBottom is the last
// layer that defines one (matching how Sheet appends footerSpacing last).
function readPaddingBottom(style: unknown): number | undefined {
  const layers = Array.isArray(style) ? style : [style];
  let result: number | undefined;
  for (const layer of layers) {
    if (layer && typeof layer === 'object' && 'paddingBottom' in layer) {
      result = (layer as { paddingBottom?: number }).paddingBottom;
    }
  }
  return result;
}

// Captured across renders so tests can assert the footer's onLayout handler, the
// scroll container's reserved paddingBottom, and the identity of the footer
// component gorhom is handed each render.
const captures = vi.hoisted(() => ({
  footerOnLayout: null as null | ((event: { nativeEvent: { layout: { height: number } } }) => void),
  scrollPaddingBottom: undefined as number | undefined,
  bodyPaddingBottom: undefined as number | undefined,
  footerChromePaddingBottom: undefined as number | undefined,
  footerComponents: [] as Array<ComponentType<{ animatedFooterPosition?: unknown }> | undefined>,
}));

type ViewMockProps = {
  children?: ReactNode;
  style?: unknown;
  onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void;
};
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: { ios?: unknown; android?: unknown }) => options.ios },
  View: ({ children, style, onLayout }: ViewMockProps) => {
    // Only the footer's inner wrapper sets onLayout — capture it so a test can
    // simulate the footer measuring and assert the body padding follows.
    if (onLayout) {
      captures.footerOnLayout = onLayout;
      captures.footerChromePaddingBottom = readPaddingBottom(style);
    }
    return createElement('div', null, children);
  },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

type FooterComponent = ComponentType<{ animatedFooterPosition?: unknown }>;
type SheetMockProps = {
  children?: ReactNode;
  footerComponent?: FooterComponent;
};
type ScrollMockProps = { children?: ReactNode; contentContainerStyle?: unknown };
vi.mock('@gorhom/bottom-sheet', () => ({
  default: forwardRef(({ children, footerComponent }: SheetMockProps, ref: Ref<unknown>) => {
    captures.footerComponents.push(footerComponent);
    return createElement(
      'div',
      { 'data-sheet': 'true', ref },
      children,
      // Render the footer the way gorhom does, inside the sheet subtree (and
      // therefore inside Sheet's footer context provider) so SheetFooter resolves.
      footerComponent ? createElement(footerComponent, { animatedFooterPosition: { value: 0 } }) : null,
    );
  }),
  BottomSheetScrollView: ({ children, contentContainerStyle }: ScrollMockProps) => {
    captures.scrollPaddingBottom = readPaddingBottom(contentContainerStyle);
    return createElement('div', { 'data-scroll': 'true' }, children);
  },
  BottomSheetView: ({ children, style }: { children?: ReactNode; style?: unknown }) => {
    // The non-scrollable branch reserves footer room on this view's style.
    captures.bodyPaddingBottom = readPaddingBottom(style);
    return createElement('div', { 'data-view': 'true' }, children);
  },
  BottomSheetFooter: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-footer': 'true' }, children),
  BottomSheetBackdrop: () => null,
}));

vi.mock('react-native-screens', () => ({
  FullWindowOverlay: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('../GlassSheetBackground', () => ({
  GlassSheetBackground: () => null,
}));

vi.mock('../../lib/haptics', () => ({
  hapticMedium: vi.fn(),
}));

vi.mock('../../theme/tokens', () => ({
  spacing: { 2: 8, 3: 12, 4: 16, 6: 24 },
  sheetStyles: { background: {} },
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#fff', separator: '#ccc' },
    sheet: { scrimOpacity: 0.5, corners: {}, handleStyle: {} },
  }),
}));

import { ESTIMATED_FOOTER_HEIGHT, Sheet } from '../Sheet';

// Mirror the values the theme/token mocks above feed into the footer chrome.
const SPACING_3 = 12;
const SPACING_4 = 16;
const INSET_BOTTOM = 34;

beforeEach(() => {
  captures.footerOnLayout = null;
  captures.scrollPaddingBottom = undefined;
  captures.bodyPaddingBottom = undefined;
  captures.footerChromePaddingBottom = undefined;
  captures.footerComponents = [];
});

describe('Sheet footer wiring', () => {
  it('reserves room for the footer on first render using the estimated height', () => {
    render(
      <Sheet scrollable footer={<div data-testid="footer">save</div>}>
        <div>body</div>
      </Sheet>,
    );

    // Before the footer measures, the body padding is the estimate + gap — not a
    // bare spacing[4], which would let the last row sit under the footer.
    expect(captures.scrollPaddingBottom).toBe(ESTIMATED_FOOTER_HEIGHT + SPACING_4);
    // The footer wrapper itself carries safe-area-aware bottom padding so the CTA
    // clears the home indicator.
    expect(captures.footerChromePaddingBottom).toBe(INSET_BOTTOM + SPACING_3);
  });

  it('reserves footer room on the non-scrollable body too', () => {
    render(
      <Sheet footer={<div data-testid="footer">save</div>}>
        <div>body</div>
      </Sheet>,
    );

    // The BottomSheetView branch (non-scrollable) must reserve the same room as
    // the scrollable branch, or its last row hides under the sticky footer.
    expect(captures.bodyPaddingBottom).toBe(ESTIMATED_FOOTER_HEIGHT + SPACING_4);
    expect(captures.footerComponents.filter(Boolean).length).toBeGreaterThan(0);
  });

  it('updates the reserved padding once the footer reports its real height', () => {
    render(
      <Sheet scrollable footer={<div data-testid="footer">save</div>}>
        <div>body</div>
      </Sheet>,
    );

    expect(captures.footerOnLayout).not.toBeNull();
    act(() => {
      captures.footerOnLayout?.({ nativeEvent: { layout: { height: 120 } } });
    });

    expect(captures.scrollPaddingBottom).toBe(120 + SPACING_4);
  });

  it('hands gorhom a stable footer component across re-renders with new inline footers', () => {
    const ref = createRef<unknown>();
    const { rerender } = render(
      <Sheet ref={ref as never} scrollable footer={<div>first</div>}>
        <div>body</div>
      </Sheet>,
    );

    // A new inline footer on every render is the real-world case (consumers pass
    // inline JSX). The component identity must not change, or gorhom remounts the
    // footer subtree (dropping a composer's keyboard focus).
    rerender(
      <Sheet ref={ref as never} scrollable footer={<div>second</div>}>
        <div>body</div>
      </Sheet>,
    );

    const distinct = new Set(captures.footerComponents.filter(Boolean));
    expect(distinct.size).toBe(1);
  });

  it('does not reserve footer padding when no footer is provided', () => {
    render(
      <Sheet scrollable>
        <div>body</div>
      </Sheet>,
    );

    expect(captures.scrollPaddingBottom).toBeUndefined();
    expect(captures.footerComponents.every((component) => component === undefined)).toBe(true);
  });
});
