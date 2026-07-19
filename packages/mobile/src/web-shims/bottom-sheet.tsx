import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import GorhomBottomSheet, {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  BottomSheetModal as GorhomBottomSheetModal,
  BottomSheetModalProvider as GorhomBottomSheetModalProvider,
  BottomSheetScrollView,
  BottomSheetSectionList,
  BottomSheetTextInput,
  BottomSheetView,
  useBottomSheet,
  type BottomSheetBackdropProps,
  type BottomSheetProps as GorhomBottomSheetProps,
} from '@gorhom/bottom-sheet';
import { useTheme } from '../providers/theme-provider';
import { material } from '../theme/tokens';
import {
  initialSheetDismissalState,
  transitionSheetDismissal,
  type SheetDismissalState,
} from './bottom-sheet-dismissal';
import { resolveGorhomDynamicSizing } from './bottom-sheet-props';

export interface BottomSheetMethods {
  snapToIndex: (index: number) => void;
  snapToPosition: (position: string | number) => void;
  expand: () => void;
  collapse: () => void;
  close: () => void;
  forceClose: () => void;
  present: () => void;
  dismiss: () => void;
}

type WebBottomSheetProps = Omit<GorhomBottomSheetProps, 'onChange'> & {
  onChange?: (index: number) => void;
  onDismiss?: () => void;
  onFullyDismissed?: () => void;
};

type GorhomSheetRef = BottomSheetMethods;
type GorhomModalRef = BottomSheetMethods;

type SheetChromeOptions = Pick<
  WebBottomSheetProps,
  'backdropComponent' | 'backgroundStyle' | 'handleIndicatorStyle' | 'enablePanDownToClose'
>;

function useSheetChrome({
  backdropComponent,
  backgroundStyle,
  handleIndicatorStyle,
  enablePanDownToClose = false,
}: SheetChromeOptions) {
  const { sheet, systemColors } = useTheme();
  const scrimOpacity = sheet.scrimOpacity ?? material.sheet.scrimOpacity;
  const defaultBackdrop = useCallback(
    (backdropProps: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...backdropProps}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={scrimOpacity}
        pressBehavior={enablePanDownToClose ? 'close' : 'none'}
      />
    ),
    [enablePanDownToClose, scrimOpacity],
  );
  const corners = sheet.corners ?? {
    borderTopLeftRadius: material.sheet.cornerRadius,
    borderTopRightRadius: material.sheet.cornerRadius,
  };
  const mergedBackgroundStyle = useMemo<StyleProp<ViewStyle>>(
    () => [{ backgroundColor: systemColors.secondaryBackground, ...corners }, backgroundStyle],
    [backgroundStyle, corners, systemColors.secondaryBackground],
  );

  return {
    backdropComponent: backdropComponent ?? defaultBackdrop,
    backgroundStyle: mergedBackgroundStyle,
    handleIndicatorStyle: handleIndicatorStyle ?? sheet.handleStyle,
  };
}

function presentedDismissalState(): SheetDismissalState {
  return transitionSheetDismissal(initialSheetDismissalState, 'present').state;
}

const BottomSheet = forwardRef<BottomSheetMethods, WebBottomSheetProps>(function BottomSheet(props, ref) {
  const {
    index: indexProp,
    onChange,
    onClose,
    onDismiss,
    onFullyDismissed,
    backdropComponent,
    backgroundStyle,
    handleIndicatorStyle,
    enablePanDownToClose = false,
    snapPoints,
    enableDynamicSizing,
    children,
    ...rest
  } = props;
  const innerRef = useRef<GorhomSheetRef>(null);
  const dismissalStateRef = useRef<SheetDismissalState>(
    indexProp === -1 ? initialSheetDismissalState : presentedDismissalState(),
  );
  const chrome = useSheetChrome({
    backdropComponent,
    backgroundStyle,
    handleIndicatorStyle,
    enablePanDownToClose,
  });
  const gorhomDynamicSizing = resolveGorhomDynamicSizing(snapPoints, enableDynamicSizing);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const onFullyDismissedRef = useRef(onFullyDismissed);
  onFullyDismissedRef.current = onFullyDismissed;

  const markPresented = useCallback(() => {
    dismissalStateRef.current = transitionSheetDismissal(dismissalStateRef.current, 'present').state;
  }, []);
  const handleChange = useCallback(
    (index: number) => {
      if (index >= 0) markPresented();
      onChangeRef.current?.(index);
    },
    [markPresented],
  );
  const handleClose = useCallback(() => {
    const transition = transitionSheetDismissal(dismissalStateRef.current, 'dismiss');
    dismissalStateRef.current = transition.state;
    if (!transition.shouldNotify) return;
    onCloseRef.current?.();
    onDismissRef.current?.();
    onFullyDismissedRef.current?.();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      snapToIndex: (index) => {
        if (index >= 0) markPresented();
        innerRef.current?.snapToIndex(index);
      },
      snapToPosition: (position) => {
        markPresented();
        innerRef.current?.snapToPosition(position);
      },
      expand: () => {
        markPresented();
        innerRef.current?.expand();
      },
      collapse: () => {
        markPresented();
        innerRef.current?.collapse();
      },
      close: () => innerRef.current?.close(),
      forceClose: () => innerRef.current?.forceClose(),
      present: () => {
        markPresented();
        // A non-modal sheet is commonly mounted at index={-1} (hidden). The
        // native `present()` contract shows the sheet regardless of mount index,
        // so clamp to the first detent instead of forwarding -1 (which Gorhom
        // resolves to `detents[-1] === undefined` and silently fails to open).
        innerRef.current?.snapToIndex(Math.max(indexProp ?? 0, 0));
      },
      dismiss: () => innerRef.current?.close(),
    }),
    [indexProp, markPresented],
  );

  return (
    <GorhomBottomSheet
      ref={innerRef}
      index={indexProp ?? 0}
      enablePanDownToClose={enablePanDownToClose}
      onChange={handleChange}
      onClose={handleClose}
      {...chrome}
      {...rest}
      snapPoints={snapPoints}
      enableDynamicSizing={gorhomDynamicSizing}
    >
      {children}
    </GorhomBottomSheet>
  );
});
type BottomSheet = BottomSheetMethods;

type PendingModalAction =
  | { type: 'index'; index: number }
  | { type: 'position'; position: string | number }
  | { type: 'expand' }
  | { type: 'collapse' };

function runModalAction(modal: GorhomModalRef, action: PendingModalAction): void {
  switch (action.type) {
    case 'index':
      modal.snapToIndex(action.index);
      break;
    case 'position':
      modal.snapToPosition(action.position);
      break;
    case 'expand':
      modal.expand();
      break;
    case 'collapse':
      modal.collapse();
      break;
  }
}

const BottomSheetModal = forwardRef<BottomSheetMethods, WebBottomSheetProps>(function BottomSheetModal(props, ref) {
  const {
    index: indexProp,
    onChange,
    onClose,
    onDismiss,
    onFullyDismissed,
    backdropComponent,
    backgroundStyle,
    handleIndicatorStyle,
    enablePanDownToClose = false,
    snapPoints,
    enableDynamicSizing,
    children,
    ...rest
  } = props;
  const initialIndex = indexProp ?? 0;
  const innerRef = useRef<GorhomModalRef>(null);
  const dismissalStateRef = useRef<SheetDismissalState>(initialSheetDismissalState);
  const isVisibleRef = useRef(false);
  const pendingActionRef = useRef<PendingModalAction | null>(null);
  const chrome = useSheetChrome({
    backdropComponent,
    backgroundStyle,
    handleIndicatorStyle,
    enablePanDownToClose,
  });
  const gorhomDynamicSizing = resolveGorhomDynamicSizing(snapPoints, enableDynamicSizing);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const onFullyDismissedRef = useRef(onFullyDismissed);
  onFullyDismissedRef.current = onFullyDismissed;

  const requestOpen = useCallback((action: PendingModalAction | null = null) => {
    const modal = innerRef.current;
    if (!modal) return;

    if (dismissalStateRef.current === 'dismissed') {
      dismissalStateRef.current = presentedDismissalState();
      pendingActionRef.current = action;
      modal.present();
      return;
    }

    if (isVisibleRef.current && action) {
      runModalAction(modal, action);
    } else if (action) {
      pendingActionRef.current = action;
    }
  }, []);

  const handleChange = useCallback((index: number) => {
    isVisibleRef.current = index >= 0;
    if (index >= 0) {
      dismissalStateRef.current = presentedDismissalState();
    }
    onChangeRef.current?.(index);

    const pendingAction = index >= 0 ? pendingActionRef.current : null;
    if (pendingAction && innerRef.current) {
      pendingActionRef.current = null;
      runModalAction(innerRef.current, pendingAction);
    }
  }, []);

  const handleDismiss = useCallback(() => {
    isVisibleRef.current = false;
    pendingActionRef.current = null;
    const transition = transitionSheetDismissal(dismissalStateRef.current, 'dismiss');
    dismissalStateRef.current = transition.state;
    if (!transition.shouldNotify) return;
    onCloseRef.current?.();
    onDismissRef.current?.();
    onFullyDismissedRef.current?.();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      snapToIndex: (index) => {
        if (index < 0) {
          innerRef.current?.dismiss();
          return;
        }
        requestOpen(index === initialIndex ? null : { type: 'index', index });
      },
      snapToPosition: (position) => requestOpen({ type: 'position', position }),
      expand: () => requestOpen({ type: 'expand' }),
      collapse: () => requestOpen({ type: 'collapse' }),
      close: () => innerRef.current?.close(),
      forceClose: () => innerRef.current?.forceClose(),
      present: () => requestOpen(),
      dismiss: () => innerRef.current?.dismiss(),
    }),
    [initialIndex, requestOpen],
  );

  return (
    <GorhomBottomSheetModal
      ref={innerRef}
      index={initialIndex}
      enablePanDownToClose={enablePanDownToClose}
      enableDismissOnClose
      stackBehavior="replace"
      onChange={handleChange}
      onDismiss={handleDismiss}
      {...chrome}
      {...rest}
      snapPoints={snapPoints}
      enableDynamicSizing={gorhomDynamicSizing}
    >
      {children}
    </GorhomBottomSheetModal>
  );
});
type BottomSheetModal = BottomSheetMethods;

function BottomSheetModalProvider({ children }: { children: ReactNode }) {
  return <GorhomBottomSheetModalProvider>{children}</GorhomBottomSheetModalProvider>;
}

export default BottomSheet;
export {
  BottomSheet,
  BottomSheetModal,
  BottomSheetModalProvider,
  BottomSheetView,
  BottomSheetScrollView,
  BottomSheetSectionList,
  BottomSheetFlatList,
  BottomSheetTextInput,
  useBottomSheet,
};
export type BottomSheetProps = WebBottomSheetProps;
export type BottomSheetViewProps = { children: ReactNode; style?: StyleProp<ViewStyle> };
export type BottomSheetHandleProps = { animatedIndex?: { value: number }; animatedPosition?: { value: number } };
export type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
export type BottomSheetBackgroundProps = {
  animatedIndex?: { value: number };
  animatedPosition?: { value: number };
  style?: StyleProp<ViewStyle>;
};
export type BottomSheetFooterProps = { animatedFooterPosition?: { value: number } };
