import type { BottomSheetMethods } from '@expo/ui/community/bottom-sheet';
import type { ClimbFilterFormModel } from './ClimbFilterForm.types';

export type NativeListPosition = { index: number; offsetDp: number };
export type ClimbFilterScrollPosition = {
  sectionKey?: string;
  offsetDp: number;
  rail?: NativeListPosition;
};
export type ClimbFilterSurfaceHandle = BottomSheetMethods & {
  captureScrollPosition: () => Promise<ClimbFilterScrollPosition>;
};
export type ClimbFilterSurfaceProps = {
  model: ClimbFilterFormModel;
  title: string;
  subtitle?: string;
  closeLabel: string;
  resetLabel: string;
  resetDisabled: boolean;
  onClosePress: () => void;
  onReset: () => void;
  onChange: (index: number) => void;
  initialScrollPosition?: ClimbFilterScrollPosition;
};
