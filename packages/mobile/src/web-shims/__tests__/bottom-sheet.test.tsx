// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { createRef, forwardRef, useImperativeHandle, useRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const presentation = vi.hoisted(() => ({
  input: 'touch' as 'mouse' | 'touch' | 'pen' | 'keyboard' | 'unknown',
  width: 390,
  height: 844,
  modalProps: null as null | {
    visible?: boolean;
    onShow?: () => void;
    onDismiss?: () => void;
    onRequestClose?: () => void;
  },
}));
vi.mock('../../lib/opening-input', () => ({
  getOpeningInput: () => presentation.input,
  startOpeningInputTracking: () => () => {},
}));
vi.mock('../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => true }));
vi.mock('react-native-gesture-handler', async () => {
  const { createElement } = await import('react');
  return { GestureHandlerRootView: ({ children }: { children?: ReactNode }) => createElement('div', null, children) };
});
vi.mock('react-native-paper', async () => {
  const { createElement } = await import('react');
  return { Portal: { Host: ({ children }: { children?: ReactNode }) => createElement('div', null, children) } };
});

type MockGorhomProps = {
  children?: ReactNode;
  enableDynamicSizing?: boolean;
  enableContentPanningGesture?: boolean;
  enableHandlePanningGesture?: boolean;
  keyboardBehavior?: string;
  keyboardBlurBehavior?: string;
  onChange?: (index: number) => void;
  onClose?: () => void;
  onDismiss?: () => void;
  snapPoints?: readonly (number | string)[];
  stackBehavior?: 'replace' | 'push';
  handleComponent?: unknown;
  enableOverDrag?: boolean;
  style?: unknown;
};

const gorhom = vi.hoisted(() => ({
  moduleId: ['@gorhom', 'bottom-sheet'].join('/'),
  state: {
    bottomSheetProps: null as MockGorhomProps | null,
    modalProps: null as MockGorhomProps | null,
    bottomSheetMethods: {
      snapToIndex: vi.fn(),
      snapToPosition: vi.fn(),
      expand: vi.fn(),
      collapse: vi.fn(),
      close: vi.fn(),
      forceClose: vi.fn(),
      present: vi.fn(),
      dismiss: vi.fn(),
    },
    modalMethods: {
      snapToIndex: vi.fn(),
      snapToPosition: vi.fn(),
      expand: vi.fn(),
      collapse: vi.fn(),
      close: vi.fn(),
      forceClose: vi.fn(),
      present: vi.fn(),
      dismiss: vi.fn(),
    },
  },
}));

vi.mock(gorhom.moduleId, async () => {
  const { createElement, forwardRef, useImperativeHandle } = await import('react');

  const Primitive = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const FlatListPrimitive = () => createElement('div', { 'data-testid': 'gorhom-flat-list' });
  const TextInputPrimitive = () => createElement('input', { 'data-testid': 'gorhom-text-input' });
  const MockBottomSheet = forwardRef<unknown, MockGorhomProps>(function MockBottomSheet(props, ref) {
    gorhom.state.bottomSheetProps = props;
    useImperativeHandle(ref, () => gorhom.state.bottomSheetMethods);
    return createElement('div', { 'data-testid': 'gorhom-bottom-sheet' }, props.children);
  });
  const MockBottomSheetModal = forwardRef<unknown, MockGorhomProps>(function MockBottomSheetModal(props, ref) {
    gorhom.state.modalProps = props;
    useImperativeHandle(ref, () => gorhom.state.modalMethods);
    return createElement('div', { 'data-testid': 'gorhom-bottom-sheet-modal' }, props.children);
  });

  return {
    default: MockBottomSheet,
    BottomSheetBackdrop: Primitive,
    BottomSheetFlatList: FlatListPrimitive,
    BottomSheetModal: MockBottomSheetModal,
    BottomSheetModalProvider: Primitive,
    BottomSheetScrollView: Primitive,
    BottomSheetSectionList: Primitive,
    BottomSheetTextInput: TextInputPrimitive,
    BottomSheetView: Primitive,
    useBottomSheet: vi.fn(),
  };
});

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    sheet: { scrimOpacity: 0.32, handleStyle: { backgroundColor: '#111111' } },
    systemColors: { secondaryBackground: '#ffffff' },
  }),
}));

vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  return {
    Platform: { OS: 'web' },
    TextInput: { State: { currentlyFocusedField: () => null } },
    useWindowDimensions: () => ({ width: presentation.width, height: presentation.height }),
    StyleSheet: {
      create: (styles: Record<string, unknown>) => styles,
      absoluteFill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
    },
    View: ({
      children,
      testID,
      style,
      nativeID,
      onClick,
    }: {
      children?: ReactNode;
      testID?: string;
      style?: unknown;
      nativeID?: string;
      onClick?: () => void;
    }) =>
      createElement(
        'div',
        { id: nativeID, onClick, 'data-testid': testID, 'data-style': JSON.stringify(style) },
        children,
      ),
    Pressable: ({ onPress, testID }: { onPress?: () => void; testID?: string }) =>
      createElement('button', { onClick: onPress, 'data-testid': testID }),
    Modal: (props: {
      children?: ReactNode;
      visible?: boolean;
      accessibilityLabel?: string;
      onShow?: () => void;
      onDismiss?: () => void;
      onRequestClose?: () => void;
    }) => {
      presentation.modalProps = props;
      return props.visible
        ? createElement(
            'div',
            { role: 'dialog', 'aria-modal': 'true', 'aria-label': props.accessibilityLabel },
            props.children,
          )
        : null;
    },
  };
});

import {
  SheetPresentationProvider,
  SHEET_SETTLE_MS,
  useManagedSheet,
  type ManagedSheetHandle,
} from '../../providers/sheet-presentation-provider';

import { WebSheetModalHost } from '../sheet-dialog';

import {
  BottomSheet,
  BottomSheetFlatList,
  BottomSheetModal,
  BottomSheetTextInput,
  type BottomSheetMethods,
} from '../bottom-sheet';

beforeEach(() => {
  presentation.input = 'touch';
  presentation.width = 390;
  presentation.height = 844;
  presentation.modalProps = null;
  gorhom.state.bottomSheetProps = null;
  gorhom.state.modalProps = null;
  for (const method of Object.values(gorhom.state.bottomSheetMethods)) method.mockReset();
  for (const method of Object.values(gorhom.state.modalMethods)) method.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Expo web bottom-sheet adapter', () => {
  it('replaces by default and preserves an explicitly stacked child sheet', () => {
    const rendered = render(
      <BottomSheetModal>
        <span />
      </BottomSheetModal>,
    );
    expect(gorhom.state.modalProps?.stackBehavior).toBe('replace');
    rendered.rerender(
      <BottomSheetModal stackBehavior="push">
        <span />
      </BottomSheetModal>,
    );
    expect(gorhom.state.modalProps?.stackBehavior).toBe('push');
  });

  it('normalizes explicit snap points before forwarding both sheet variants to Gorhom', () => {
    render(
      <>
        <BottomSheet snapPoints={['40%', '90%']} enableDynamicSizing>
          <span />
        </BottomSheet>
        <BottomSheetModal snapPoints={['50%', '95%']} enableDynamicSizing>
          <span />
        </BottomSheetModal>
      </>,
    );

    expect(gorhom.state.bottomSheetProps).toMatchObject({
      snapPoints: ['40%', '90%'],
      enableDynamicSizing: false,
    });
    expect(gorhom.state.modalProps).toMatchObject({
      snapPoints: ['50%', '95%'],
      enableDynamicSizing: false,
    });
  });

  it('forwards queue gesture locks and ascent keyboard contracts to Gorhom', () => {
    render(
      <BottomSheetModal
        enableContentPanningGesture={false}
        enableHandlePanningGesture={false}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
      >
        <span />
      </BottomSheetModal>,
    );

    expect(gorhom.state.modalProps).toMatchObject({
      enableContentPanningGesture: false,
      enableHandlePanningGesture: false,
      keyboardBehavior: 'extend',
      keyboardBlurBehavior: 'restore',
    });
  });

  it('exports Gorhom sheet-aware list and text-input primitives', () => {
    const rendered = render(
      <>
        <BottomSheetFlatList data={[]} renderItem={() => null} />
        <BottomSheetTextInput />
      </>,
    );

    expect(rendered.getByTestId('gorhom-flat-list')).toBeTruthy();
    expect(rendered.getByTestId('gorhom-text-input')).toBeTruthy();
  });

  it('presents a modal and waits until Gorhom mounts it before applying a requested index', () => {
    const sheetRef = createRef<BottomSheetMethods>();
    render(
      <BottomSheetModal ref={sheetRef} index={0} snapPoints={['40%', '90%']}>
        <span />
      </BottomSheetModal>,
    );

    act(() => sheetRef.current?.snapToIndex(1));
    expect(gorhom.state.modalMethods.present).toHaveBeenCalledTimes(1);
    expect(gorhom.state.modalMethods.snapToIndex).not.toHaveBeenCalled();

    act(() => gorhom.state.modalProps?.onChange?.(0));
    expect(gorhom.state.modalMethods.snapToIndex).toHaveBeenCalledTimes(1);
    expect(gorhom.state.modalMethods.snapToIndex).toHaveBeenCalledWith(1);

    act(() => gorhom.state.modalProps?.onChange?.(1));
    expect(gorhom.state.modalMethods.snapToIndex).toHaveBeenCalledTimes(1);
  });

  it('uses present for the initial index and applies later visible modal actions immediately', () => {
    const sheetRef = createRef<BottomSheetMethods>();
    render(
      <BottomSheetModal ref={sheetRef} index={1} snapPoints={['30%', '80%']}>
        <span />
      </BottomSheetModal>,
    );

    act(() => sheetRef.current?.present());
    expect(gorhom.state.modalMethods.present).toHaveBeenCalledTimes(1);
    expect(gorhom.state.modalMethods.snapToIndex).not.toHaveBeenCalled();

    act(() => gorhom.state.modalProps?.onChange?.(1));
    act(() => sheetRef.current?.snapToIndex(0));
    expect(gorhom.state.modalMethods.snapToIndex).toHaveBeenCalledWith(0);
  });

  it('presents a non-modal sheet mounted at index=-1 by clamping to the first detent', () => {
    const sheetRef = createRef<BottomSheetMethods>();
    render(
      <BottomSheet ref={sheetRef} index={-1} snapPoints={['40%', '90%']}>
        <span />
      </BottomSheet>,
    );

    act(() => sheetRef.current?.present());
    // Forwarding -1 would resolve to `detents[-1] === undefined` and never open.
    expect(gorhom.state.bottomSheetMethods.snapToIndex).toHaveBeenCalledTimes(1);
    expect(gorhom.state.bottomSheetMethods.snapToIndex).toHaveBeenCalledWith(0);
  });

  it('maps close and dismiss commands to the correct Gorhom primitive', () => {
    const sheetRef = createRef<BottomSheetMethods>();
    const modalRef = createRef<BottomSheetMethods>();
    render(
      <>
        <BottomSheet ref={sheetRef}>
          <span />
        </BottomSheet>
        <BottomSheetModal ref={modalRef}>
          <span />
        </BottomSheetModal>
      </>,
    );

    act(() => {
      sheetRef.current?.close();
      sheetRef.current?.dismiss();
      modalRef.current?.close();
      modalRef.current?.dismiss();
      modalRef.current?.snapToIndex(-1);
    });

    expect(gorhom.state.bottomSheetMethods.close).toHaveBeenCalledTimes(2);
    expect(gorhom.state.modalMethods.close).toHaveBeenCalledTimes(1);
    expect(gorhom.state.modalMethods.dismiss).toHaveBeenCalledTimes(2);
  });

  it('reports a missing closed index before terminal dismissal, without duplicate close edges', () => {
    const sheetRef = createRef<BottomSheetMethods>();
    const callbacks: string[] = [];
    const onChange = vi.fn((index: number) => callbacks.push(`change:${index}`));
    const onFullyDismissed = vi.fn(() => callbacks.push('dismissed'));
    render(
      <BottomSheetModal ref={sheetRef} onChange={onChange} onFullyDismissed={onFullyDismissed}>
        <span />
      </BottomSheetModal>,
    );

    act(() => sheetRef.current?.present());
    act(() => gorhom.state.modalProps?.onDismiss?.());
    expect(callbacks).toEqual(['change:-1', 'dismissed']);
    act(() => gorhom.state.modalProps?.onChange?.(-1));
    act(() => gorhom.state.modalProps?.onDismiss?.());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onFullyDismissed).toHaveBeenCalledTimes(1);

    act(() => sheetRef.current?.present());
    act(() => gorhom.state.modalProps?.onChange?.(0));
    act(() => gorhom.state.modalProps?.onChange?.(-1));
    act(() => gorhom.state.modalProps?.onDismiss?.());
    expect(callbacks).toEqual(['change:-1', 'dismissed', 'change:0', 'change:-1', 'dismissed']);
  });

  it('reopens a settled managed modal after a backdrop dismissal that omitted index changes', () => {
    vi.useFakeTimers();
    const ManagedModal = forwardRef<ManagedSheetHandle>(function ManagedModal(_modalProps, ref) {
      const sheetRef = useRef<BottomSheetMethods>(null);
      const managed = useManagedSheet({ sheetRef });
      useImperativeHandle(ref, () => managed.handle, [managed.handle]);
      return (
        <BottomSheetModal ref={sheetRef} onChange={managed.onChange} onFullyDismissed={managed.onFullyDismissed}>
          <span />
        </BottomSheetModal>
      );
    });
    const managedRef = createRef<ManagedSheetHandle>();
    const rendered = render(
      <SheetPresentationProvider>
        <ManagedModal ref={managedRef} />
      </SheetPresentationProvider>,
    );
    try {
      act(() => managedRef.current?.present());
      void act(() => vi.advanceTimersByTime(SHEET_SETTLE_MS));
      act(() => gorhom.state.modalProps?.onDismiss?.());
      act(() => managedRef.current?.present());
      expect(gorhom.state.modalMethods.present).toHaveBeenCalledTimes(2);
    } finally {
      rendered.unmount();
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('notifies each modal dismissal callback exactly once per presentation cycle', () => {
    const sheetRef = createRef<BottomSheetMethods>();
    const onClose = vi.fn();
    const onDismiss = vi.fn();
    const onFullyDismissed = vi.fn();
    render(
      <BottomSheetModal ref={sheetRef} onClose={onClose} onDismiss={onDismiss} onFullyDismissed={onFullyDismissed}>
        <span />
      </BottomSheetModal>,
    );

    act(() => sheetRef.current?.present());
    act(() => gorhom.state.modalProps?.onChange?.(0));
    act(() => {
      gorhom.state.modalProps?.onDismiss?.();
      gorhom.state.modalProps?.onDismiss?.();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onFullyDismissed).toHaveBeenCalledTimes(1);

    act(() => sheetRef.current?.present());
    act(() => gorhom.state.modalProps?.onDismiss?.());
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(onFullyDismissed).toHaveBeenCalledTimes(2);
  });

  it('notifies each plain-sheet dismissal callback exactly once per open cycle', () => {
    const onClose = vi.fn();
    const onDismiss = vi.fn();
    const onFullyDismissed = vi.fn();
    render(
      <BottomSheet onClose={onClose} onDismiss={onDismiss} onFullyDismissed={onFullyDismissed} index={0}>
        <span />
      </BottomSheet>,
    );

    act(() => {
      gorhom.state.bottomSheetProps?.onClose?.();
      gorhom.state.bottomSheetProps?.onClose?.();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onFullyDismissed).toHaveBeenCalledTimes(1);

    act(() => gorhom.state.bottomSheetProps?.onChange?.(0));
    act(() => gorhom.state.bottomSheetProps?.onClose?.());
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(onFullyDismissed).toHaveBeenCalledTimes(2);
  });
});

describe('mouse dialog presentation', () => {
  it('uses one bounded state and retains Gorhom input/list primitives', () => {
    presentation.input = 'mouse';
    presentation.width = 1440;
    presentation.height = 1000;
    const sheetRef = createRef<BottomSheetMethods>();
    const onChange = vi.fn();
    const rendered = render(
      <BottomSheetModal ref={sheetRef} accessibilityLabel="Log a send" snapPoints={['50%', '90%']} onChange={onChange}>
        <BottomSheetFlatList data={[]} renderItem={() => null} />
        <BottomSheetTextInput />
      </BottomSheetModal>,
    );
    act(() => sheetRef.current?.present());
    expect(rendered.getByRole('dialog', { name: 'Log a send' })).toBeTruthy();
    expect(rendered.getByTestId('sheet-dialog-surface').getAttribute('data-style')).toContain('"width":560');
    expect(rendered.getByTestId('sheet-dialog-surface').getAttribute('data-style')).toContain('"height":720');
    expect(gorhom.state.bottomSheetProps).toMatchObject({
      snapPoints: ['100%'],
      enableDynamicSizing: false,
      enableContentPanningGesture: false,
      enableHandlePanningGesture: false,
      enableOverDrag: false,
      handleComponent: null,
    });
    expect(rendered.getByTestId('gorhom-flat-list')).toBeTruthy();
    expect(rendered.getByTestId('gorhom-text-input')).toBeTruthy();
    act(() => presentation.modalProps?.onShow?.());
    act(() => {
      sheetRef.current?.snapToIndex(1);
      sheetRef.current?.expand();
      sheetRef.current?.collapse();
    });
    expect(onChange.mock.calls).toEqual([[0]]);
    expect(gorhom.state.bottomSheetMethods.snapToIndex).not.toHaveBeenCalled();
  });

  it('captures prepared input before a queued opening and latches across resizing', () => {
    presentation.width = 1440;
    const sheetRef = createRef<BottomSheetMethods>();
    const content = (
      <BottomSheetModal ref={sheetRef} surfaceSize="list">
        <span />
      </BottomSheetModal>
    );
    const rendered = render(content);
    act(() => sheetRef.current?.preparePresentation?.('mouse'));
    presentation.input = 'touch';
    act(() => sheetRef.current?.present());
    expect(rendered.getByRole('dialog')).toBeTruthy();
    expect(rendered.getByTestId('sheet-dialog-surface').getAttribute('data-style')).toContain('"width":672');
    presentation.width = 390;
    rendered.rerender(
      <BottomSheetModal ref={sheetRef} surfaceSize="list">
        <span />
      </BottomSheetModal>,
    );
    expect(rendered.getByRole('dialog')).toBeTruthy();
    expect(rendered.getByTestId('sheet-dialog-surface').getAttribute('data-style')).toContain('"width":342');
    act(() => sheetRef.current?.dismiss());
    act(() => presentation.modalProps?.onDismiss?.());
    presentation.width = 1440;
    rendered.rerender(
      <BottomSheetModal ref={sheetRef} surfaceSize="list">
        <span />
      </BottomSheetModal>,
    );
    act(() => sheetRef.current?.present());
    expect(rendered.queryByRole('dialog')).toBeNull();
    expect(gorhom.state.modalMethods.present).toHaveBeenCalledTimes(1);
    expect(gorhom.state.modalProps?.style).toEqual(expect.arrayContaining([{ marginLeft: 400, marginRight: 400 }]));
  });

  it('routes Escape and scrim requests through the guard, with terminal callbacks once', () => {
    presentation.input = 'keyboard';
    presentation.width = 1200;
    const sheetRef = createRef<BottomSheetMethods>();
    const callbacks: string[] = [];
    const requestClose = vi.fn();
    const rendered = render(
      <BottomSheetModal
        ref={sheetRef}
        onRequestClose={requestClose}
        enablePanDownToClose={false}
        onChange={(index) => callbacks.push(`change:${index}`)}
        onClose={() => callbacks.push('close')}
        onDismiss={() => callbacks.push('dismiss')}
        onFullyDismissed={() => callbacks.push('settled')}
      >
        <span />
      </BottomSheetModal>,
    );
    act(() => sheetRef.current?.present());
    act(() => presentation.modalProps?.onShow?.());
    act(() => presentation.modalProps?.onRequestClose?.());
    fireEvent.click(rendered.getByTestId('sheet-dialog-backdrop'));
    expect(requestClose).toHaveBeenCalledTimes(2);
    expect(rendered.getByRole('dialog')).toBeTruthy();
    act(() => sheetRef.current?.close());
    act(() => {
      presentation.modalProps?.onDismiss?.();
      presentation.modalProps?.onDismiss?.();
    });
    expect(callbacks).toEqual(['change:0', 'change:-1', 'close', 'dismiss', 'settled']);
  });

  it('ignores an old dismissal callback after reopening', () => {
    presentation.input = 'mouse';
    presentation.width = 1200;
    const sheetRef = createRef<BottomSheetMethods>();
    const onClose = vi.fn();
    const rendered = render(
      <BottomSheetModal ref={sheetRef} onClose={onClose}>
        <span />
      </BottomSheetModal>,
    );
    act(() => sheetRef.current?.present());
    act(() => sheetRef.current?.close());
    const staleDismiss = presentation.modalProps?.onDismiss;
    act(() => sheetRef.current?.present());
    act(() => staleDismiss?.());
    expect(rendered.getByRole('dialog')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('sheet close races and nested menus', () => {
  it('does not reopen a hidden or closing dialog for late detent requests', () => {
    presentation.input = 'mouse';
    presentation.width = 1200;
    const sheetRef = createRef<BottomSheetMethods>();
    const rendered = render(
      <BottomSheetModal ref={sheetRef}>
        <span />
      </BottomSheetModal>,
    );
    act(() => {
      sheetRef.current?.expand();
      sheetRef.current?.collapse();
      sheetRef.current?.snapToPosition('90%');
    });
    expect(rendered.queryByRole('dialog')).toBeNull();
    act(() => sheetRef.current?.present());
    act(() => sheetRef.current?.close());
    act(() => {
      sheetRef.current?.snapToIndex(1);
      sheetRef.current?.expand();
      sheetRef.current?.collapse();
    });
    expect(rendered.queryByRole('dialog')).toBeNull();
    act(() => presentation.modalProps?.onDismiss?.());
    act(() => {
      sheetRef.current?.expand();
      sheetRef.current?.snapToPosition('90%');
    });
    expect(rendered.queryByRole('dialog')).toBeNull();
    act(() => sheetRef.current?.snapToIndex(0));
    expect(rendered.getByRole('dialog')).toBeTruthy();
  });

  it('lets an in-modal menu own Escape before closing the sheet', async () => {
    const requestClose = vi.fn();
    const rendered = render(
      <WebSheetModalHost onRequestClose={requestClose}>
        <button role="menuitem">Send</button>
      </WebSheetModalHost>,
    );
    fireEvent.keyUp(document, { key: 'Escape' });
    act(() => presentation.modalProps?.onRequestClose?.());
    expect(requestClose).not.toHaveBeenCalled();
    rendered.getByRole('menuitem').remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    act(() => presentation.modalProps?.onRequestClose?.());
    expect(requestClose).toHaveBeenCalledTimes(1);
  });
});
