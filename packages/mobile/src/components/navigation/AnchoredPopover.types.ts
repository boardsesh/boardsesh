import type { ReactElement } from 'react';
export type AnchoredPopoverProps = {
  visible: boolean;
  onClose: () => void;
  trigger: ReactElement;
  content: ReactElement;
  width?: number;
};
