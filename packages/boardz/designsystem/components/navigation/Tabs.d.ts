import * as React from 'react';

/** Underline tabs for switching sections within a screen. */
export interface TabsProps {
  items: { value: string; label: string; count?: number }[];
  value?: string;
  onChange?: (v: string) => void;
  style?: React.CSSProperties;
}

export declare function Tabs(props: TabsProps): React.JSX.Element;
