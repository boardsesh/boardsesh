import * as React from 'react';

/** Lucide icon by kebab-case name; use for every glyph in the UI. */
export interface IconProps {
  name: string;
  size?: number;
  strokeWidth?: number;
  color?: string;
  fill?: string;
  style?: React.CSSProperties;
}

export declare function Icon(props: IconProps): React.JSX.Element;
