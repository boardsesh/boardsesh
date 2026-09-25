// @vitest-environment jsdom
//
// #5665: with the keyboard up, the logbook edit sheet's Note field sat under the
// keyboard. Nothing scrolled the sheet body to the focused field, and nothing
// raised the sheet to its keyboard detent. These tests drive the real `Sheet` and
// the real `TickNoteField` against a fake native ScrollView and TextInput, using
// the edit sheet's reference geometry (`tick-sheet-metrics.ts`).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, useImperativeHandle, type ReactNode, type Ref } from 'react';

type LayoutEvent = { nativeEvent: { layout: { height: number } } };
type ScrollMockProps = {
  children?: ReactNode;
  ref?: Ref<unknown>;
  onLayout?: (event: LayoutEvent) => void;
  onContentSizeChange?: (width: number, height: number) => void;
  onScroll?: (event: { nativeEvent: { contentOffset: { y: number } } }) => void;
};
type InputMockProps = {
  ref?: Ref<unknown>;
  onFocus?: () => void;
  onBlur?: () => void;
  onContentSizeChange?: () => void;
};

// Edit sheet rows above the note: status 56 + date 56 + grade 60 + angle 64 +
// stars 56 + tries 60 = 352, plus the note row's 4pt `alignTop` inset.
const NOTE_TOP = 356;
const NOTE_HEIGHT = 64;
// Body height at the 80% detent (595 column - 56 header - 140 footer) and with
// the keyboard up at the 92% detent (see TickNoteField's derivation).
const BODY_AT_REST = 399;
const BODY_KEYBOARD_UP = 162;
const CONTENT_HEIGHT = 540;

const native = vi.hoisted(() => ({
  scrollTo: vi.fn(),
  snapToIndex: vi.fn(),
  contentView: { tag: 'content-view' },
  measuredRelativeTo: [] as unknown[],
  scroll: null as null | ScrollMockProps,
  input: null as null | InputMockProps,
  platformOs: 'ios',
}));

vi.mock('@expo/ui/community/bottom-sheet', () => ({
  default: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  BottomSheetScrollView: function ScrollViewMock(props: ScrollMockProps) {
    native.scroll = props;
    useImperativeHandle(props.ref, () => ({
      scrollTo: native.scrollTo,
      getInnerViewRef: () => native.contentView,
    }));
    return createElement('div', null, props.children);
  },
  BottomSheetView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  BottomSheetTextInput: function TextInputMock(props: InputMockProps) {
    native.input = props;
    useImperativeHandle(
      props.ref,
      () => ({
        measureLayout: (
          relativeTo: unknown,
          onSuccess: (left: number, top: number, width: number, height: number) => void,
        ) => {
          native.measuredRelativeTo.push(relativeTo);
          onSuccess(84, NOTE_TOP, 290, NOTE_HEIGHT);
        },
        // Stable across renders, like the real TextInput host instance.
      }),
      [],
    );
    return createElement('textarea');
  },
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return native.platformOs;
    },
    Version: '26.1',
    select: (options: { ios?: unknown }) => options.ios,
  },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    hairlineWidth: 1,
    absoluteFill: {},
    flatten: (style: unknown) => style,
  },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('../../lib/haptics', () => ({ hapticMedium: () => {} }));

vi.mock('../../providers/sheet-presentation-provider', () => ({
  useManagedSheet: () => ({
    onChange: () => {},
    onFullyDismissed: () => {},
    handle: { snapToIndex: native.snapToIndex },
  }),
}));

vi.mock('../../theme/tokens', () => ({ spacing: { 2: 8, 3: 12, 4: 16, 6: 24 } }));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#fff', separator: '#ccc', fill: '#eee', label: '#000' },
    brandColors: { primary: '#6D28D9' },
    borderRadius: { lg: 12 },
    spacing: { 2: 8, 3: 12 },
    textStyles: { subheadline: {} },
    sheet: { handleStyle: {} },
  }),
}));

import { Sheet } from '../Sheet';
import { TickNoteField } from '../tick/TickNoteField';
import { revealScrollOffset, SHEET_REVEAL_MARGIN } from '../sheet-scroll-into-view';

function renderEditSheetNote(snapPoints: string[] = ['80%', '92%']) {
  render(
    <Sheet scrollable snapPoints={snapPoints} header={<div />} footer={<div />}>
      <TickNoteField value="" onChangeText={() => {}} placeholder="Note" accessibilityLabel="Note" />
    </Sheet>,
  );
  act(() => {
    native.scroll?.onContentSizeChange?.(390, CONTENT_HEIGHT);
    native.scroll?.onLayout?.({ nativeEvent: { layout: { height: BODY_AT_REST } } });
  });
}

function layoutBody(height: number) {
  act(() => native.scroll?.onLayout?.({ nativeEvent: { layout: { height } } }));
}

beforeEach(() => {
  native.scrollTo.mockClear();
  native.snapToIndex.mockClear();
  native.measuredRelativeTo = [];
  native.scroll = null;
  native.input = null;
  native.platformOs = 'ios';
});

describe('revealScrollOffset', () => {
  const base = { targetY: NOTE_TOP, targetHeight: NOTE_HEIGHT, contentHeight: CONTENT_HEIGHT, margin: 12 };

  it('lifts the edit-sheet note clear of the keyboard-up footer', () => {
    // 356 + 64 + 12 - 162 = 270: the note's bottom lands 12pt above the footer.
    expect(revealScrollOffset({ ...base, viewportHeight: BODY_KEYBOARD_UP, currentOffset: 0 })).toBe(270);
  });

  it('leaves a field that is already in view alone', () => {
    expect(revealScrollOffset({ ...base, viewportHeight: BODY_KEYBOARD_UP, currentOffset: 270 })).toBeNull();
  });

  it('scrolls back up to a field above the fold', () => {
    expect(revealScrollOffset({ ...base, viewportHeight: BODY_KEYBOARD_UP, currentOffset: 400 })).toBe(NOTE_TOP);
  });

  it('shows the top of a field taller than the viewport', () => {
    expect(revealScrollOffset({ ...base, targetHeight: 200, viewportHeight: 150, currentOffset: 0 })).toBe(NOTE_TOP);
  });

  it('never scrolls past the end of the content', () => {
    expect(
      revealScrollOffset({ ...base, contentHeight: 400, viewportHeight: BODY_KEYBOARD_UP, currentOffset: 0 }),
    ).toBe(400 - BODY_KEYBOARD_UP);
  });

  it('waits for a measured viewport', () => {
    expect(revealScrollOffset({ ...base, viewportHeight: 0, currentOffset: 0 })).toBeNull();
  });
});

describe('Sheet + TickNoteField', () => {
  it('raises the sheet to its keyboard detent when the note gets focus', () => {
    renderEditSheetNote();
    act(() => native.input?.onFocus?.());
    expect(native.snapToIndex).toHaveBeenCalledWith(1);
  });

  it('scrolls the note clear of the footer once the keyboard shrinks the body', () => {
    renderEditSheetNote();
    act(() => native.input?.onFocus?.());
    layoutBody(BODY_KEYBOARD_UP);

    expect(native.measuredRelativeTo.at(-1)).toBe(native.contentView);
    expect(native.scrollTo).toHaveBeenLastCalledWith({
      y: NOTE_TOP + NOTE_HEIGHT + SHEET_REVEAL_MARGIN - BODY_KEYBOARD_UP,
      animated: true,
    });
  });

  it('keeps the note in view as it grows a line', () => {
    renderEditSheetNote();
    act(() => native.input?.onFocus?.());
    layoutBody(BODY_KEYBOARD_UP);
    // The climber scrolled the note back out of view, then typed a line.
    act(() => native.scroll?.onScroll?.({ nativeEvent: { contentOffset: { y: 0 } } }));
    native.scrollTo.mockClear();
    act(() => native.input?.onContentSizeChange?.());
    expect(native.scrollTo).toHaveBeenCalledTimes(1);
  });

  it('stops following the note after it blurs', () => {
    renderEditSheetNote();
    act(() => native.input?.onFocus?.());
    act(() => native.input?.onBlur?.());
    native.scrollTo.mockClear();
    layoutBody(BODY_KEYBOARD_UP);
    expect(native.scrollTo).not.toHaveBeenCalled();
  });

  it('does not request a detent change for a single-detent sheet', () => {
    renderEditSheetNote(['92%']);
    act(() => native.input?.onFocus?.());
    expect(native.snapToIndex).not.toHaveBeenCalled();
  });

  it('leaves web alone, where the Gorhom shim handles the keyboard', () => {
    native.platformOs = 'web';
    renderEditSheetNote();
    act(() => native.input?.onFocus?.());
    layoutBody(BODY_KEYBOARD_UP);
    expect(native.snapToIndex).not.toHaveBeenCalled();
    expect(native.scrollTo).not.toHaveBeenCalled();
  });
});
