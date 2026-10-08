import type { ReactElement } from 'react';
export type AnchoredPopoverProps = {
  visible: boolean;
  onClose: () => void;
  trigger: ReactElement;
  content: ReactElement;
  width?: number;
};

/** Gesture position in its native window; convert to the presenting root locally. */
export type WindowAnchorPoint = { x: number; y: number };
