import * as React from 'react';

/** Modal surface: bottom sheet on phone, dialog on tablet/desktop, side panel for filters. */
export interface SheetProps {
  open: boolean;
  onClose?: () => void;
  title?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  variant?: 'bottom' | 'dialog' | 'side';
  contained?: boolean;
  width?: number;
  style?: React.CSSProperties;
}

export declare function Sheet(props: SheetProps): React.JSX.Element;
