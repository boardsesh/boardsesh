import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ComponentType,
} from 'react';
import { TextInput, type StyleProp, type ViewStyle } from 'react-native';
import { SheetPresentationContext } from '../components/sheet-presentation-context';
import { startOpeningInputTracking } from '../lib/opening-input';
import type { OpeningInput, SheetPresentationOptions } from '../lib/sheet-presentation-policy';
import { useWebSheetPresentation } from './web-sheet-presentation';
import { SheetDialog, WebSheetModalHost } from './sheet-dialog';
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
import { installWebTextInputFocusCompat } from './text-input-focus-compat';

// This shim is imported by the root layout before any screen can blur an input.
// Install the shared RNW alias for both Gorhom and Expo Router's keyboard manager.
installWebTextInputFocusCompat(TextInput.State);

export interface BottomSheetMethods {
  preparePresentation?: (input: OpeningInput) => void;
  snapToIndex: (index: number) => void;
  snapToPosition: (position: string | number) => void;
  expand: () => void;
  collapse: () => void;
  close: () => void;
  forceClose: () => void;
  present: () => void;
  dismiss: () => void;
}

type WebBottomSheetProps = Omit<GorhomBottomSheetProps, 'onChange'> &
  SheetPresentationOptions & {
    stackBehavior?: 'replace' | 'push';
    onChange?: (index: number) => void;
    onDismiss?: () => void;
    onFullyDismissed?: () => void;
  };

type GorhomSheetRef = BottomSheetMethods;
type GorhomModalRef = BottomSheetMethods;

type SheetChromeOptions = Pick<
  WebBottomSheetProps,
  'backdropComponent' | 'backgroundStyle' | 'handleIndicatorStyle' | 'enablePanDownToClose' | 'onRequestClose'
>;

function useSheetChrome({
  backdropComponent,
  backgroundStyle,
  handleIndicatorStyle,
  enablePanDownToClose = false,
  onRequestClose,
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
        pressBehavior={onRequestClose ? 'none' : enablePanDownToClose ? 'close' : 'none'}
        onPress={onRequestClose}
      />
    ),
    [enablePanDownToClose, onRequestClose, scrimOpacity],
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

const TouchBottomSheet = forwardRef<BottomSheetMethods, WebBottomSheetProps>(function TouchBottomSheet(props, ref) {
  const {
    index: indexProp,
    onChange,
    onClose,
    onDismiss,
    onFullyDismissed,
    onRequestClose,
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
    onRequestClose,
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

const TouchBottomSheetModal = forwardRef<
  BottomSheetMethods,
  WebBottomSheetProps & { containerComponent?: ComponentType<{ children?: ReactNode }> }
>(function TouchBottomSheetModal(props, ref) {
  const {
    stackBehavior = 'replace',
    index: indexProp,
    onChange,
    onClose,
    onDismiss,
    onFullyDismissed,
    onRequestClose,
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
  const lastChangeIndexRef = useRef<number | null>(null);
  const pendingActionRef = useRef<PendingModalAction | null>(null);
  const chrome = useSheetChrome({
    backdropComponent,
    backgroundStyle,
    handleIndicatorStyle,
    enablePanDownToClose,
    onRequestClose,
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
      lastChangeIndexRef.current = null;
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
    const duplicateClose = index === -1 && lastChangeIndexRef.current === -1;
    lastChangeIndexRef.current = index;
    isVisibleRef.current = index >= 0;
    if (index >= 0) {
      dismissalStateRef.current = presentedDismissalState();
    }
    if (!duplicateClose) onChangeRef.current?.(index);

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
    // Gorhom web can dismiss without reporting index -1. The coordinator needs
    // that close edge before the terminal callback, or it keeps this sheet
    // marked as presented and ignores the next request to open it.
    if (lastChangeIndexRef.current !== -1) {
      lastChangeIndexRef.current = -1;
      onChangeRef.current?.(-1);
    }
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
      stackBehavior={stackBehavior}
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

type SurfaceAction = PendingModalAction | { type: 'present' };

function runSurfaceAction(surface: BottomSheetMethods, action: SurfaceAction): void {
  if (action.type === 'present') surface.present();
  else runModalAction(surface, action);
}

/** The controller owns presentation identity; resizing only updates geometry. */
const AdaptiveBottomSheet = forwardRef<BottomSheetMethods, WebBottomSheetProps & { modal: boolean }>(
  function AdaptiveBottomSheet({ modal, surfaceSize = 'form', accessibilityLabel, onRequestClose, ...props }, ref) {
    const presentation = useWebSheetPresentation(surfaceSize);
    const [accessibleTitle, setAccessibleTitle] = useState<string>();
    const label = accessibilityLabel ?? accessibleTitle ?? 'Boardsesh';
    const initialDialogOpen = !modal && props.index !== -1 && presentation.mode === 'dialog';
    const [dialogVisible, setDialogVisible] = useState(initialDialogOpen);
    const [touchVisible, setTouchVisible] = useState(!modal && props.index !== -1);
    const touchVisibleRef = useRef(touchVisible);
    const dialogVisibleRef = useRef(initialDialogOpen);
    const dialogDismissalRef = useRef<SheetDismissalState>(
      initialDialogOpen ? presentedDismissalState() : initialSheetDismissalState,
    );
    const dialogNotifiedRef = useRef(false);
    const phaseRef = useRef<'dismissed' | 'opening' | 'open' | 'closing'>(
      !modal && props.index !== -1 ? 'opening' : 'dismissed',
    );
    const touchRef = useRef<BottomSheetMethods>(null);
    const renderedModeRef = useRef(presentation.mode);
    renderedModeRef.current = presentation.mode;
    const pendingTouchActionRef = useRef<SurfaceAction | null>(null);
    const propsRef = useRef(props);
    propsRef.current = props;
    const requestCloseRef = useRef(onRequestClose);
    requestCloseRef.current = onRequestClose;
    const { capturePresentation, releasePresentation, preparePresentation, modeRef } = presentation;

    const closeDialog = useCallback(() => {
      if (phaseRef.current !== 'dismissed') phaseRef.current = 'closing';
      dialogVisibleRef.current = false;
      setDialogVisible(false);
    }, []);
    const closeSurface = useCallback(() => {
      pendingTouchActionRef.current = null;
      if (phaseRef.current !== 'dismissed') phaseRef.current = 'closing';
      if (modeRef.current === 'dialog') closeDialog();
      else touchRef.current?.close();
    }, [closeDialog, modeRef]);
    const requestUserClose = useCallback(() => {
      if (requestCloseRef.current) requestCloseRef.current();
      else if (propsRef.current.enablePanDownToClose) closeSurface();
    }, [closeSurface]);
    const requestOpen = useCallback(
      (action: SurfaceAction) => {
        if (phaseRef.current === 'closing' && action.type !== 'present') return;
        if (phaseRef.current === 'dismissed' && action.type !== 'present' && action.type !== 'index') return;
        if (phaseRef.current === 'dismissed') phaseRef.current = 'opening';
        const mode = capturePresentation();
        if (mode === 'dialog') {
          if (!dialogVisibleRef.current) dialogNotifiedRef.current = false;
          dialogDismissalRef.current = presentedDismissalState();
          dialogVisibleRef.current = true;
          setDialogVisible(true);
        } else if (!modal && !touchVisibleRef.current) {
          touchVisibleRef.current = true;
          setTouchVisible(true);
          pendingTouchActionRef.current = action;
        } else if (renderedModeRef.current === 'sheet' && touchRef.current) {
          runSurfaceAction(touchRef.current, action);
        } else {
          pendingTouchActionRef.current = action;
        }
      },
      [capturePresentation, modal],
    );
    useEffect(() => {
      if (presentation.mode !== 'sheet' || !pendingTouchActionRef.current || !touchRef.current) return;
      const action = pendingTouchActionRef.current;
      pendingTouchActionRef.current = null;
      runSurfaceAction(touchRef.current, action);
    }, [presentation.mode, touchVisible]);
    const previousIndexRef = useRef(props.index);
    useEffect(() => {
      if (modal) return;
      if (previousIndexRef.current !== props.index) {
        previousIndexRef.current = props.index;
        if (props.index === -1) closeSurface();
        else requestOpen({ type: 'index', index: props.index ?? 0 });
      } else if (props.index !== -1) capturePresentation();
    }, [modal, props.index, capturePresentation, closeSurface, requestOpen]);

    const handleDialogShown = useCallback(() => {
      if (!dialogVisibleRef.current || dialogNotifiedRef.current) return;
      dialogNotifiedRef.current = true;
      phaseRef.current = 'open';
      propsRef.current.onChange?.(0);
    }, []);
    const handleDialogDismissed = useCallback(() => {
      // A stale animation completion cannot close a presentation that reopened.
      if (dialogVisibleRef.current) return;
      const transition = transitionSheetDismissal(dialogDismissalRef.current, 'dismiss');
      dialogDismissalRef.current = transition.state;
      if (!transition.shouldNotify) return;
      dialogNotifiedRef.current = false;
      phaseRef.current = 'dismissed';
      releasePresentation();
      propsRef.current.onChange?.(-1);
      propsRef.current.onClose?.();
      propsRef.current.onDismiss?.();
      propsRef.current.onFullyDismissed?.();
    }, [releasePresentation]);
    const handleTouchDismissed = useCallback(() => {
      phaseRef.current = 'dismissed';
      touchVisibleRef.current = false;
      setTouchVisible(false);
      releasePresentation();
      propsRef.current.onFullyDismissed?.();
    }, [releasePresentation]);

    const handleTouchChange = useCallback((index: number) => {
      phaseRef.current = index < 0 ? 'closing' : 'open';
      propsRef.current.onChange?.(index);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        preparePresentation,
        snapToIndex: (index) => {
          if (index >= 0) requestOpen({ type: 'index', index });
          else {
            pendingTouchActionRef.current = null;
            if (phaseRef.current !== 'dismissed') phaseRef.current = 'closing';
            if (modeRef.current === 'dialog') closeDialog();
            else touchRef.current?.snapToIndex(index);
          }
        },
        snapToPosition: (position) => requestOpen({ type: 'position', position }),
        expand: () => requestOpen({ type: 'expand' }),
        collapse: () => requestOpen({ type: 'collapse' }),
        close: closeSurface,
        forceClose: () => {
          if (phaseRef.current !== 'dismissed') phaseRef.current = 'closing';
          if (modeRef.current === 'dialog') closeDialog();
          else touchRef.current?.forceClose();
        },
        present: () => requestOpen({ type: 'present' }),
        dismiss: () => {
          if (phaseRef.current !== 'dismissed') phaseRef.current = 'closing';
          if (modeRef.current === 'dialog') closeDialog();
          else touchRef.current?.dismiss();
        },
      }),
      [preparePresentation, closeSurface, requestOpen, modeRef, closeDialog],
    );

    const touchHostOptionsRef = useRef({ label, requestUserClose });
    touchHostOptionsRef.current = { label, requestUserClose };
    const TouchModalContainer = useMemo(
      () =>
        function TouchModalContainer({ children }: { children?: ReactNode }) {
          return (
            <WebSheetModalHost
              accessibilityLabel={touchHostOptionsRef.current.label}
              onRequestClose={touchHostOptionsRef.current.requestUserClose}
            >
              {children}
            </WebSheetModalHost>
          );
        },
      [],
    );

    const context = useMemo(
      () => ({
        mode: presentation.mode,
        supportsDetents: presentation.mode === 'sheet',
        setAccessibleTitle,
      }),
      [presentation.mode],
    );
    if (presentation.mode === 'dialog') {
      const {
        onChange: _onChange,
        onClose: _onClose,
        onDismiss: _onDismiss,
        onFullyDismissed: _onFullyDismissed,
        stackBehavior: _stackBehavior,
        children,
        ...sheetProps
      } = props;
      return (
        <SheetDialog
          visible={dialogVisible}
          accessibilityLabel={label}
          onRequestClose={requestUserClose}
          onShown={handleDialogShown}
          onDismissed={handleDialogDismissed}
          onSheetClose={closeDialog}
          viewport={presentation.viewport}
          bounds={presentation.bounds}
          backgroundStyle={props.backgroundStyle}
          sheetProps={sheetProps}
        >
          <SheetPresentationContext value={context}>{children}</SheetPresentationContext>
        </SheetDialog>
      );
    }
    const horizontalStart = presentation.viewport.left + (presentation.viewport.width - presentation.bounds.width) / 2;
    const horizontalEnd = presentation.viewport.layoutWidth - horizontalStart - presentation.bounds.width;
    const surfaceStyle = [props.style, { marginLeft: horizontalStart, marginRight: horizontalEnd }];
    const touchProps = {
      ...props,
      accessibilityLabel: label,
      onRequestClose: requestUserClose,
      style: surfaceStyle,
      onChange: handleTouchChange,
      onFullyDismissed: handleTouchDismissed,
    };
    const content = <SheetPresentationContext value={context}>{props.children}</SheetPresentationContext>;
    return modal ? (
      <TouchBottomSheetModal {...touchProps} ref={touchRef} containerComponent={TouchModalContainer}>
        {content}
      </TouchBottomSheetModal>
    ) : (
      <WebSheetModalHost visible={touchVisible} accessibilityLabel={label} onRequestClose={requestUserClose}>
        <TouchBottomSheet {...touchProps} ref={touchRef}>
          {content}
        </TouchBottomSheet>
      </WebSheetModalHost>
    );
  },
);

const BottomSheet = forwardRef<BottomSheetMethods, WebBottomSheetProps>(function BottomSheet(props, ref) {
  return <AdaptiveBottomSheet {...props} ref={ref} modal={false} />;
});
type BottomSheet = BottomSheetMethods;
const BottomSheetModal = forwardRef<BottomSheetMethods, WebBottomSheetProps>(function BottomSheetModal(props, ref) {
  return <AdaptiveBottomSheet {...props} ref={ref} modal />;
});
type BottomSheetModal = BottomSheetMethods;

function BottomSheetModalProvider({ children }: { children: ReactNode }) {
  useEffect(startOpeningInputTracking, []);
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
