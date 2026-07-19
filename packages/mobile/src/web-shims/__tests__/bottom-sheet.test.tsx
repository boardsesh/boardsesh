// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { createRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

import {
  BottomSheet,
  BottomSheetFlatList,
  BottomSheetModal,
  BottomSheetTextInput,
  type BottomSheetMethods,
} from '../bottom-sheet';

beforeEach(() => {
  gorhom.state.bottomSheetProps = null;
  gorhom.state.modalProps = null;
  for (const method of Object.values(gorhom.state.bottomSheetMethods)) method.mockReset();
  for (const method of Object.values(gorhom.state.modalMethods)) method.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Expo web bottom-sheet adapter', () => {
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
