import * as React from 'react';

/** Toggle chip for secondary filters on tablet/desktop. On phone prefer SegmentedControl `multiple` (44px cells). */
export interface ChipProps {
  label: string;
  selected?: boolean;
  icon?: string;
  count?: number | string;
  onClick?: () => void;
  onRemove?: () => void;
  /** sm 32 · md 36 · lg 44 */
  size?: 'sm' | 'md' | 'lg';
  style?: React.CSSProperties;
}

export declare function Chip(props: ChipProps): React.JSX.Element;
