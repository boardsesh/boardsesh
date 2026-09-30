import * as React from 'react';

/** Native select styled to match inputs. */
export interface SelectProps {
  label?: string;
  value?: string;
  onChange?: (v: string) => void;
  options: (string | { value: string; label: string })[];
  size?: 'sm' | 'md' | 'lg';
  style?: React.CSSProperties;
}

export declare function Select(props: SelectProps): React.JSX.Element;
