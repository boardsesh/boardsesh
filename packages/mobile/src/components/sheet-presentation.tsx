import { forwardRef } from 'react';
import ExpoBottomSheet, {
  BottomSheetModal as ExpoBottomSheetModal,
  type BottomSheetProps as ExpoBottomSheetProps,
  type BottomSheetMethods as ExpoBottomSheetMethods,
} from '@expo/ui/community/bottom-sheet';
import type { OpeningInput, SheetPresentationOptions } from '../lib/sheet-presentation-policy';

export * from '@expo/ui/community/bottom-sheet';
export { SheetPresentationContent, useSheetPresentation } from './sheet-presentation-context';
export type BottomSheetMethods = ExpoBottomSheetMethods & { preparePresentation?: (input: OpeningInput) => void };
export type BottomSheetProps = ExpoBottomSheetProps & SheetPresentationOptions;

/** Native outer geometry and gestures remain owned by UIKit and Material. */
export const BottomSheet = forwardRef<BottomSheetMethods, BottomSheetProps>(function BottomSheet(
  { surfaceSize: _surfaceSize, accessibilityLabel: _label, onRequestClose: _requestClose, children, ...props },
  ref,
) {
  return (
    <ExpoBottomSheet {...props} ref={ref}>
      {children}
    </ExpoBottomSheet>
  );
});
export type BottomSheet = BottomSheetMethods;
export const BottomSheetModal = forwardRef<BottomSheetMethods, BottomSheetProps>(function BottomSheetModal(
  { surfaceSize: _surfaceSize, accessibilityLabel: _label, onRequestClose: _requestClose, children, ...props },
  ref,
) {
  return (
    <ExpoBottomSheetModal {...props} ref={ref}>
      {children}
    </ExpoBottomSheetModal>
  );
});
export type BottomSheetModal = BottomSheetMethods;
export default BottomSheet;
