import * as React from 'react';

/** Transient confirmation (sent logged, board connected, errors). */
export interface ToastProps {
  title: string;
  message?: string;
  tone?: 'success' | 'danger' | 'info' | 'accent';
  actionLabel?: string;
  onAction?: () => void;
  onClose?: () => void;
  style?: React.CSSProperties;
}

export declare function Toast(props: ToastProps): React.JSX.Element;
