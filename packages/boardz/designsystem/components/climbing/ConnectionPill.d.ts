import * as React from 'react';

/** Bluetooth board status pill — always visible in the top bar. */
export interface ConnectionPillProps {
  status?: 'disconnected' | 'scanning' | 'connected' | 'error';
  boardName?: string;
  onClick?: () => void;
  compact?: boolean;
  style?: React.CSSProperties;
}

export declare function ConnectionPill(props: ConnectionPillProps): React.JSX.Element;
