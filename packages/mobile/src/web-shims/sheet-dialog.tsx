import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Modal, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Portal } from 'react-native-paper';
import GorhomBottomSheet, { type BottomSheetProps as GorhomBottomSheetProps } from '@gorhom/bottom-sheet';
import { useTheme } from '../providers/theme-provider';
import { useReduceMotion } from '../hooks/use-reduce-motion';
import { material } from '../theme/tokens';
import type { WebSheetViewport } from './web-sheet-presentation';

const playerShortcutBoundary = { dataSet: { boardseshPlayerShortcutBlock: 'true' } };

type WebSheetModalHostProps = {
  visible?: boolean;
  accessibilityLabel?: string;
  onRequestClose: () => void;
  onShown?: () => void;
  onDismissed?: () => void;
  animate?: boolean;
  children: ReactNode;
};

/** Modal owns focus/Escape; Paper's portal must keep the viewport coordinate origin. */
export function WebSheetModalHost({
  visible = true,
  accessibilityLabel,
  onRequestClose,
  onShown,
  onDismissed,
  animate = false,
  children,
}: WebSheetModalHostProps) {
  const reduceMotion = useReduceMotion();
  const portalHostId = useId();
  const menuOwnsEscapeRef = useRef(false);
  useEffect(() => {
    if (!visible || typeof document === 'undefined') return;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    // Paper Menu and RNW Modal both listen on document keyup. Let the menu
    // handle this Escape without also dismissing its owning sheet.
    const observeEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const menu = document.getElementById(portalHostId)?.querySelector('[role="menuitem"]');
      if (!menu) return;
      menuOwnsEscapeRef.current = true;
      // Keep ownership for the whole browser event task, including native listeners.
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        menuOwnsEscapeRef.current = false;
      }, 0);
    };
    document.addEventListener('keyup', observeEscape, true);
    return () => {
      clearTimeout(resetTimer);
      menuOwnsEscapeRef.current = false;
      document.removeEventListener('keyup', observeEscape, true);
    };
  }, [visible, portalHostId]);
  return (
    <Modal
      visible={visible}
      transparent
      animationType={animate && !reduceMotion ? 'fade' : 'none'}
      onRequestClose={() => {
        if (!menuOwnsEscapeRef.current) onRequestClose();
      }}
      onShow={onShown}
      onDismiss={onDismissed}
      accessibilityLabel={accessibilityLabel}
    >
      <GestureHandlerRootView style={styles.fill}>
        <View nativeID={portalHostId} style={styles.fill} {...playerShortcutBoundary}>
          <Portal.Host>{children}</Portal.Host>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

type SheetDialogProps = {
  visible: boolean;
  accessibilityLabel?: string;
  onRequestClose: () => void;
  onShown: () => void;
  onDismissed: () => void;
  onSheetClose: () => void;
  bounds: { width: number; height: number };
  viewport: WebSheetViewport;
  backgroundStyle?: StyleProp<ViewStyle>;
  sheetProps: Omit<GorhomBottomSheetProps, 'children'>;
  children: ReactNode;
};

/** A real Gorhom host retains the context needed by lists and focused inputs. */
export function SheetDialog({
  visible,
  accessibilityLabel,
  onRequestClose,
  onShown,
  onDismissed,
  onSheetClose,
  bounds,
  viewport,
  backgroundStyle,
  sheetProps,
  children,
}: SheetDialogProps) {
  const { sheet, systemColors } = useTheme();
  return (
    <WebSheetModalHost
      visible={visible}
      accessibilityLabel={accessibilityLabel}
      onRequestClose={onRequestClose}
      onShown={onShown}
      onDismissed={onDismissed}
      animate
    >
      {/* A Pressable remains programmatically focusable in RNW’s focus trap,
          even at tabIndex -1. Keep the scrim out of keyboard traversal. */}
      <View
        testID="sheet-dialog-backdrop"
        {...{ onClick: onRequestClose }}
        style={[styles.backdrop, { opacity: sheet.scrimOpacity ?? material.sheet.scrimOpacity }]}
      />
      <View
        pointerEvents="box-none"
        style={[
          styles.viewport,
          { width: viewport.width, height: viewport.height, top: viewport.top, left: viewport.left },
        ]}
      >
        <View
          testID="sheet-dialog-surface"
          accessibilityLabel={accessibilityLabel}
          style={[
            styles.surface,
            { width: bounds.width, height: bounds.height, backgroundColor: systemColors.secondaryBackground },
          ]}
        >
          <GorhomBottomSheet
            {...sheetProps}
            index={0}
            snapPoints={['100%']}
            enableDynamicSizing={false}
            animateOnMount={false}
            enablePanDownToClose={false}
            enableContentPanningGesture={false}
            enableHandlePanningGesture={false}
            enableOverDrag={false}
            handleComponent={null}
            backdropComponent={undefined}
            backgroundStyle={[backgroundStyle, styles.dialogBackground]}
            onChange={undefined}
            onClose={onSheetClose}
          >
            {children}
          </GorhomBottomSheet>
        </View>
      </View>
    </WebSheetModalHost>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: '#000' },
  viewport: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  surface: { borderRadius: material.sheet.cornerRadius, overflow: 'hidden' },
  dialogBackground: { borderRadius: material.sheet.cornerRadius },
});
