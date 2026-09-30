import * as React from 'react';

/** Hover/focus label for icon-only controls on desktop. */
export interface TooltipProps {
  label: string;
  children: React.ReactNode;
  side?: 'top' | 'bottom';
  forceOpen?: boolean;
  style?: React.CSSProperties;
}

export declare function Tooltip(props: TooltipProps): React.JSX.Element;
