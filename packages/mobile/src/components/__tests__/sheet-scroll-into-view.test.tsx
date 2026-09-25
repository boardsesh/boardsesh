// @vitest-environment jsdom
//
// #5665: with the keyboard up, the logbook edit sheet's Note field sat under the
// keyboard. Nothing scrolled the sheet body to the focused field, and nothing
// raised the sheet to its keyboard detent. These tests drive the real `Sheet` /
// `ModalSheet` and the real `TickNoteField` against a fake native sheet,
// ScrollView and TextInput, using the edit sheet's reference geometry
// (`tick-sheet-metrics.ts`).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement, useImperativeHandle, type ReactNode, type Ref } from 'react';

type LayoutEvent = { nativeEvent: { layout: { height: number } } };
type OffsetEvent = { nativeEvent: { contentOffset: { y: number } } };
type ScrollMockProps = {
  children?: ReactNode;
  ref?: Ref<unknown>;
  onLayout?: (event: LayoutEvent) => void;
  onContentSizeChange?: (width: number, height: number) => void;
  onScroll?: (event: OffsetEvent) => void;
  onMomentumScrollEnd?: (event: OffsetEvent) => void;
  scrollEventThrottle?: number;
};
type InputMockProps = {
  ref?: Ref<unknown>;
  onFocus?: () => void;
  onBlur?: () => void;
  onContentSizeChange?: () => void;
};
type NativeSheetMockProps = { children?: ReactNode; onChange?: (index: number) => void };

// Edit sheet rows above the note: status 56 + date 56 + grade 60 + angle 64 +
// stars 56 + tries 60 = 352, plus the note row's 4pt `alignTop` inset.
const NOTE_TOP = 356;
const NOTE_HEIGHT = 64;
// Body height at the 80% detent (595 column - 56 header - 140 footer) and with
// the keyboard up at the 92% detent (see TickNoteField's derivation).
const BODY_AT_REST = 399;
const BODY_KEYBOARD_UP = 162;
const CONTENT_HEIGHT = 540;
// 356 + 64 + 12 - 162: the note's bottom 12pt above the footer.
const NOTE_REVEALED = 270;

const native = vi.hoisted(() => ({
  scrollTo: vi.fn(),
  snapToIndex: vi.fn(),
  hapticMedium: vi.fn(),
  probeLayout: vi.fn(),
  sheetOnChange: null as null | ((index: number) => void),
  contentView: { tag: 'content-view' },
  measuredRelativeTo: [] as unknown[],
  scroll: null as null | ScrollMockProps,
  input: null as null | InputMockProps,
  platformOs: 'ios',
}));

vi.mock('@expo/ui/community/bottom-sheet', () => {
  // Like @expo/ui on both platforms, the native sheet reports the new index
  // through `onChange` synchronously; the test's `snapToIndex` mock calls this.
  function NativeSheetMock({ children, onChange }: NativeSheetMockProps) {
    native.sheetOnChange = onChange ?? null;
    return createElement('div', null, children);
  }
  return {
    default: NativeSheetMock,
    BottomSheetModal: NativeSheetMock,
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
        }),
        // Stable across renders, like the real TextInput host instance.
        [],
      );
      return createElement('textarea');
    },
  };
});

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

vi.mock('../../lib/haptics', () => ({ hapticMedium: () => native.hapticMedium() }));

// The #3922 probe is dev-only; stub it so its body `onLayout` is observable.
vi.mock('../sheet-detent-probe', () => ({
  useSheetDetentProbe: () => ({ probeProps: null, sentinelProps: null, onColumnLayout: native.probeLayout }),
}));

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
import { ModalSheet } from '../ModalSheet';
import { TickNoteField } from '../tick/TickNoteField';
import { revealScrollOffset } from '../sheet-scroll-into-view';

type HostProps = {
  scrollable: boolean;
  snapPoints?: string[];
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
};
type SheetHost = (props: HostProps) => ReactNode;

const SheetHostView: SheetHost = (props) => <Sheet {...props} />;
const ModalSheetHostView: SheetHost = (props) => <ModalSheet {...props} />;

function renderNoteSheet(SheetComponent: SheetHost, snapPoints: string[] = ['80%', '92%']) {
  render(
    <SheetComponent scrollable snapPoints={snapPoints} header={<div />} footer={<div />}>
      <TickNoteField value="" onChangeText={() => {}} placeholder="Note" accessibilityLabel="Note" />
    </SheetComponent>,
  );
  act(() => {
    native.scroll?.onContentSizeChange?.(390, CONTENT_HEIGHT);
    native.scroll?.onLayout?.({ nativeEvent: { layout: { height: BODY_AT_REST } } });
  });
}

const focusNote = () => act(() => native.input?.onFocus?.());
const blurNote = () => act(() => native.input?.onBlur?.());
const growNote = () => act(() => native.input?.onContentSizeChange?.());
const layoutBody = (height: number) => act(() => native.scroll?.onLayout?.({ nativeEvent: { layout: { height } } }));
// The climber drags the sheet to a detent (a native onChange nobody asked for).
const dragSheetTo = (index: number) => act(() => native.sheetOnChange?.(index));

beforeEach(() => {
  native.scrollTo.mockClear();
  native.snapToIndex.mockReset();
  native.snapToIndex.mockImplementation((index: number) => native.sheetOnChange?.(index));
  native.hapticMedium.mockClear();
  native.probeLayout.mockClear();
  native.sheetOnChange = null;
  native.measuredRelativeTo = [];
  native.scroll = null;
  native.input = null;
  native.platformOs = 'ios';
});

describe('revealScrollOffset', () => {
  const base = { targetY: NOTE_TOP, targetHeight: NOTE_HEIGHT, contentHeight: CONTENT_HEIGHT, margin: 12 };

  it('lifts the edit-sheet note clear of the keyboard-up footer', () => {
    expect(revealScrollOffset({ ...base, viewportHeight: BODY_KEYBOARD_UP, currentOffset: 0 })).toBe(NOTE_REVEALED);
  });

  it('leaves a field that is already in view alone', () => {
    expect(revealScrollOffset({ ...base, viewportHeight: BODY_KEYBOARD_UP, currentOffset: NOTE_REVEALED })).toBeNull();
  });

  it('scrolls back up to a field above the fold', () => {
    expect(revealScrollOffset({ ...base, viewportHeight: BODY_KEYBOARD_UP, currentOffset: 400 })).toBe(NOTE_TOP);
  });

  // An iPhone 13 mini with the keyboard up: 812 - 50 - 24 = 738 x 0.92 = 679,
  // less 336 keyboard, 56 header, 140 footer = ~147pt of body.
  const SMALL_PHONE_BODY = 147;

  it('drops the margin first when a long note and its margin do not fit', () => {
    // 140 + 12 > 147, but 140 alone fits: bottom-align with no margin.
    expect(revealScrollOffset({ ...base, targetHeight: 140, viewportHeight: SMALL_PHONE_BODY, currentOffset: 0 })).toBe(
      NOTE_TOP + 140 - SMALL_PHONE_BODY,
    );
  });

  it('keeps the bottom (the caret line) of a note taller than the body in view', () => {
    // The note at its 160pt maxHeight: its bottom, not its top, lands on screen.
    expect(revealScrollOffset({ ...base, targetHeight: 160, viewportHeight: SMALL_PHONE_BODY, currentOffset: 0 })).toBe(
      NOTE_TOP + 160 - SMALL_PHONE_BODY,
    );
    // Already bottom-aligned with its top above the fold: stays put.
    expect(
      revealScrollOffset({
        ...base,
        targetHeight: 160,
        viewportHeight: SMALL_PHONE_BODY,
        currentOffset: NOTE_TOP + 160 - SMALL_PHONE_BODY,
      }),
    ).toBeNull();
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

describe.each([
  ['Sheet', SheetHostView],
  ['ModalSheet', ModalSheetHostView],
] as const)('%s + TickNoteField', (_name, SheetComponent) => {
  it('raises the sheet to its keyboard detent on focus, without the drag haptic', () => {
    renderNoteSheet(SheetComponent);
    focusNote();
    expect(native.snapToIndex).toHaveBeenCalledWith(1);
    expect(native.hapticMedium).not.toHaveBeenCalled();
  });

  it('still gives a climber-driven detent change its haptic', () => {
    renderNoteSheet(SheetComponent);
    dragSheetTo(1);
    expect(native.hapticMedium).toHaveBeenCalledTimes(1);
  });

  it('scrolls the note clear of the footer once the keyboard shrinks the body', () => {
    renderNoteSheet(SheetComponent);
    focusNote();
    layoutBody(BODY_KEYBOARD_UP);

    expect(native.measuredRelativeTo.at(-1)).toBe(native.contentView);
    expect(native.scrollTo).toHaveBeenLastCalledWith({ y: NOTE_REVEALED, animated: true });
  });

  it('does not re-snap a sheet already at its keyboard detent', () => {
    renderNoteSheet(SheetComponent);
    focusNote();
    blurNote();
    focusNote();
    expect(native.snapToIndex).toHaveBeenCalledTimes(1);
  });

  it('keeps the note in view as it grows, without springing a dragged-down sheet back up', () => {
    renderNoteSheet(SheetComponent);
    focusNote();
    layoutBody(BODY_KEYBOARD_UP);
    // Mid-note the climber drags the sheet down a detent...
    dragSheetTo(0);
    native.snapToIndex.mockClear();
    native.scrollTo.mockClear();
    // ...and the note scrolled out of view on the way.
    act(() => native.scroll?.onScroll?.({ nativeEvent: { contentOffset: { y: 0 } } }));
    growNote();
    expect(native.snapToIndex).not.toHaveBeenCalled();
    expect(native.scrollTo).toHaveBeenCalledTimes(1);
  });

  it('tracks the offset a fling settles on', () => {
    renderNoteSheet(SheetComponent);
    focusNote();
    layoutBody(BODY_KEYBOARD_UP);
    native.scrollTo.mockClear();
    // A fling back to the top that no throttled onScroll reported.
    act(() => native.scroll?.onMomentumScrollEnd?.({ nativeEvent: { contentOffset: { y: 0 } } }));
    growNote();
    expect(native.scrollTo).toHaveBeenCalledWith({ y: NOTE_REVEALED, animated: true });
  });

  it('stops following the note after it blurs', () => {
    renderNoteSheet(SheetComponent);
    focusNote();
    blurNote();
    native.scrollTo.mockClear();
    layoutBody(BODY_KEYBOARD_UP);
    expect(native.scrollTo).not.toHaveBeenCalled();
  });

  it('does not request a detent change for a single-detent sheet', () => {
    renderNoteSheet(SheetComponent, ['92%']);
    focusNote();
    expect(native.snapToIndex).not.toHaveBeenCalled();
  });

  it('leaves web to the Gorhom shim: no reveal, and only the probe onLayout on its scrollable', () => {
    native.platformOs = 'web';
    renderNoteSheet(SheetComponent);
    focusNote();
    layoutBody(BODY_KEYBOARD_UP);
    expect(native.snapToIndex).not.toHaveBeenCalled();
    expect(native.scrollTo).not.toHaveBeenCalled();
    // Gorhom sets scrollEventThrottle={16} then spreads our props over it.
    expect(native.scroll?.scrollEventThrottle).toBeUndefined();
    expect(native.scroll?.onScroll).toBeUndefined();
  });

  it('still runs the #3922 probe on a chrome-less scrollable sheet', () => {
    render(
      <SheetComponent scrollable>
        <div />
      </SheetComponent>,
    );
    layoutBody(BODY_AT_REST);
    expect(native.probeLayout).toHaveBeenCalledTimes(1);
  });
});
