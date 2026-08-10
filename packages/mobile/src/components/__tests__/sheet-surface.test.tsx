// @vitest-environment jsdom
//
// The three sheet props the tick-sheet redesign added — `surface`,
// `footerSurface` and `header` — for BOTH wrappers, since Sheet and ModalSheet
// carry byte-identical copies of that code and a fix applied to one has already
// been forgotten on the other.
//
// The load-bearing case is `surface="solid"`. @expo/ui's `extractBackgroundColor`
// (BottomSheet.ios.tsx:26) does `typeof color === 'string'` and SILENTLY falls
// back to the glass material for anything else — a `PlatformColor`, an
// `OpaqueColorValue`, a themed object. No warning, no error: the form just goes
// see-through again. So the assertion here is on the string-ness of the value,
// not only on which token it came from.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, forwardRef, type ComponentType, type ReactNode, type Ref } from 'react';

// What the wrappers hand the native sheet: the background style (the `surface`
// decision), the KeyboardAvoidingView's style (the #3330 detent bound), the
// scroll body's style, and every plain View style (the footer bar is found
// among them by its hairline top border).
const captures = vi.hoisted(() => ({
  backgroundStyle: undefined as unknown,
  kavRendered: false,
  kavStyle: undefined as unknown,
  scrollStyle: undefined as unknown,
  viewStyles: [] as unknown[],
}));

type SheetMockProps = { children?: ReactNode; backgroundStyle?: unknown };
type ViewMockProps = { children?: ReactNode; style?: unknown };

// Faithful recursive flatten (nested arrays merge left-to-right) so the tests
// read the effective style the way React Native would.
function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  if (style && typeof style === 'object') return style as Record<string, unknown>;
  return {};
}

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  default: forwardRef(({ children, backgroundStyle }: SheetMockProps, ref: Ref<unknown>) => {
    captures.backgroundStyle = backgroundStyle;
    return createElement('div', { 'data-sheet': 'true', ref }, children);
  }),
  BottomSheetModal: forwardRef(({ children, backgroundStyle }: SheetMockProps, ref: Ref<unknown>) => {
    captures.backgroundStyle = backgroundStyle;
    return createElement('div', { 'data-sheet': 'true', ref }, children);
  }),
  BottomSheetScrollView: ({ children, style }: ViewMockProps) => {
    captures.scrollStyle = style;
    return createElement('div', { 'data-scroll': 'true' }, children);
  },
  BottomSheetView: ({ children }: ViewMockProps) =>
    createElement('div', { 'data-bottom-sheet-view': 'true' }, children),
}));

vi.mock('react-native', () => ({
  // iOS 26.1 + these window dimensions are what make useSheetColumnStyle emit a
  // numeric detent bound, which is the thing the header test checks lands on a
  // single in-flow child.
  Platform: {
    OS: 'ios',
    Version: '26.1',
    select: (options: { ios?: unknown; android?: unknown }) => options.ios,
  },
  PlatformColor: (name: string) => name,
  View: ({ children, style }: ViewMockProps) => {
    captures.viewStyles.push(style);
    return createElement('div', null, children);
  },
  KeyboardAvoidingView: ({ children, style }: ViewMockProps) => {
    captures.kavRendered = true;
    captures.kavStyle = style;
    return createElement('div', { 'data-kav': 'true' }, children);
  },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
    // Consumed by the #3922 detent probe (sheet-detent-probe.ts).
    absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    flatten: function flatten(style: unknown): Record<string, unknown> | undefined {
      if (style == null || style === false) return undefined;
      if (Array.isArray(style)) {
        const out: Record<string, unknown> = {};
        for (const entry of style) {
          const flat = flatten(entry);
          if (flat) Object.assign(out, flat);
        }
        return out;
      }
      return style as Record<string, unknown>;
    },
  },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('../../lib/haptics', () => ({ hapticMedium: vi.fn() }));

// The coordinator's serialization is covered by sheet-presentation-provider.test.tsx.
vi.mock('../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: () => ({
    onChange: vi.fn(),
    onFullyDismissed: vi.fn(),
    handle: {
      present: vi.fn(),
      dismiss: vi.fn(),
      close: vi.fn(),
      forceClose: vi.fn(),
      snapToIndex: vi.fn(),
      snapToPosition: vi.fn(),
      expand: vi.fn(),
      collapse: vi.fn(),
    },
  }),
}));

// The real token factory, not a hand-rolled partial: `sheetSurface` has to be
// the value production resolves, or the `typeof === 'string'` assertion below
// would be testing the mock rather than the theme.
vi.mock('../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../test/theme-mock');
  const theme = makeThemeMock();
  return { useTheme: () => theme };
});

import { Sheet } from '../Sheet';
import { ModalSheet } from '../ModalSheet';
import { makeThemeMock } from '../../test/theme-mock';

const theme = makeThemeMock();

// Both wrappers expose the same props; the ref types differ (BottomSheetMethods
// vs ManagedSheetHandle), which is irrelevant here — none of these tests take a ref.
type SheetLikeProps = {
  children?: ReactNode;
  surface?: 'glass' | 'solid';
  footerSurface?: 'plate' | 'flush';
  footer?: ReactNode;
  header?: ReactNode;
  scrollable?: boolean;
};

const sheetWrappers: [name: string, Component: ComponentType<SheetLikeProps>][] = [
  ['Sheet', Sheet as unknown as ComponentType<SheetLikeProps>],
  ['ModalSheet', ModalSheet as unknown as ComponentType<SheetLikeProps>],
];

/** The pinned footer bar, identified by the hairline top border only it carries. */
function footerBarStyle(): Record<string, unknown> {
  const bars = captures.viewStyles.map(flattenStyle).filter((style) => style.borderTopWidth !== undefined);
  expect(bars).toHaveLength(1);
  return bars[0];
}

beforeEach(() => {
  captures.backgroundStyle = undefined;
  captures.kavRendered = false;
  captures.kavStyle = undefined;
  captures.scrollStyle = undefined;
  captures.viewStyles = [];
});

describe.each(sheetWrappers)('%s surface props', (_name, SheetLike) => {
  describe('surface', () => {
    it('paints the opaque sheetSurface as a PLAIN STRING when solid', () => {
      // @expo/ui keeps a PlatformColor out of the native background with no
      // error — a regression to a themed/opaque colour value would be invisible
      // at runtime and only show up as a see-through data-entry form.
      render(
        <SheetLike surface="solid">
          <div>body</div>
        </SheetLike>,
      );

      const background = flattenStyle(captures.backgroundStyle);
      expect(background.backgroundColor).toBe(theme.sheetSurface);
      expect(typeof background.backgroundColor).toBe('string');
    });

    it('leaves the native glass background untouched by default', () => {
      // Pre-change behaviour: no backgroundStyle at all, so the native material
      // (iOS 26 glass / Material scrim) draws the ground.
      render(
        <SheetLike>
          <div>body</div>
        </SheetLike>,
      );

      expect(captures.backgroundStyle).toBeUndefined();
    });

    it('leaves the native glass background untouched when explicitly glass', () => {
      render(
        <SheetLike surface="glass">
          <div>body</div>
        </SheetLike>,
      );

      expect(captures.backgroundStyle).toBeUndefined();
    });
  });

  describe('footerSurface', () => {
    it('keeps the raised plate by default', () => {
      render(
        <SheetLike footer={<div>save</div>}>
          <div>body</div>
        </SheetLike>,
      );

      const footer = footerBarStyle();
      expect(footer.backgroundColor).toBe(theme.systemColors.secondaryBackground);
      expect(footer.borderTopWidth).toBe(1);
      expect(footer.borderTopColor).toBe(theme.systemColors.separator);
    });

    it('goes transparent when flush, keeping the hairline top border', () => {
      // Flush footers sit on a `surface="solid"` sheet: the plate would read as
      // a second ground, but the seam still needs its hairline.
      render(
        <SheetLike surface="solid" footerSurface="flush" footer={<div>save</div>}>
          <div>body</div>
        </SheetLike>,
      );

      const footer = footerBarStyle();
      expect(footer.backgroundColor).toBe('transparent');
      expect(footer.borderTopWidth).toBe(1);
      expect(footer.borderTopColor).toBe(theme.systemColors.separator);
    });
  });

  describe('header', () => {
    it('renders the header above the body', () => {
      const { getByTestId } = render(
        <SheetLike header={<div data-testid="header">title</div>}>
          <div data-testid="body">body</div>
        </SheetLike>,
      );

      const header = getByTestId('header');
      const body = getByTestId('body');
      expect(header).toBeTruthy();
      // DOCUMENT_POSITION_FOLLOWING (4) — the body comes after the header.
      expect(header.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('takes the KeyboardAvoidingView branch, so the #3330 column bound lands on one in-flow child', () => {
      // A header alone (no footer) must still wrap the body: the native sheet
      // takes exactly ONE in-flow child, and that child is what carries the iOS
      // detent bound. Default snap points ['50%','90%'] at index 0 on an 844pt
      // window with a 0 top inset: round((844 − 24pt card gap) * 0.5) − 20pt top
      // chrome = 390. The body inside it just fills the column.
      render(
        <SheetLike scrollable header={<div data-testid="header">title</div>}>
          <div>body</div>
        </SheetLike>,
      );

      expect(captures.kavRendered).toBe(true);
      expect(flattenStyle(captures.kavStyle)).toEqual({ height: 390 });
      expect(flattenStyle(captures.scrollStyle)).toEqual({ flex: 1 });
    });

    it('leaves a header-less, footer-less sheet with the bound on the body itself', () => {
      // The control for the test above: with no chrome there is no wrapper, so
      // the body IS the single child and carries the detent bound directly.
      render(
        <SheetLike scrollable>
          <div>body</div>
        </SheetLike>,
      );

      expect(captures.kavRendered).toBe(false);
      expect(flattenStyle(captures.scrollStyle)).toEqual({ height: 390 });
    });

    it('renders header, body and footer together in that order', () => {
      const { getByTestId } = render(
        <SheetLike header={<div data-testid="header">title</div>} footer={<div data-testid="footer">save</div>}>
          <div data-testid="body">body</div>
        </SheetLike>,
      );

      const header = getByTestId('header');
      const body = getByTestId('body');
      const footer = getByTestId('footer');
      expect(header.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(body.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
