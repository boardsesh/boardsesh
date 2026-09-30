import * as React from 'react';

/** Phone bottom navigation (max 5 items). */
export interface TabBarProps {
  items: { value: string; label: string; icon: string }[];
  value?: string;
  onChange?: (v: string) => void;
  style?: React.CSSProperties;
}

export declare function TabBar(props: TabBarProps): React.JSX.Element;
