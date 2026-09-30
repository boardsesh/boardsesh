import * as React from 'react';

type SegOption = string | { value: string; label: React.ReactNode; icon?: string; iconRight?: string; grow?: number };

/**
 * Control strip — hairline box split into cells; selected cells fill with ink.
 * Single choice by default; `multiple` turns it into a row of filter toggles.
 */
export interface SegmentedControlProps {
  options: SegOption[];
  /** string, or string[] when `multiple` */
  value?: string | string[];
  onChange?: (v: any) => void;
  multiple?: boolean;
  /** sm 32 · md 40 · lg 44 (phone filters) · xl 56 (board mode) */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  fullWidth?: boolean;
  style?: React.CSSProperties;
}

export declare function SegmentedControl(props: SegmentedControlProps): React.JSX.Element;
