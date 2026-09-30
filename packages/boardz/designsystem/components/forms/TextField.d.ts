import * as React from 'react';

/** Text / search input with label, leading icon, clear and hint/error. */
export interface TextFieldProps {
  label?: string;
  value?: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  icon?: string;
  clearable?: boolean;
  hint?: string;
  error?: string;
  size?: 'sm' | 'md' | 'lg';
  type?: string;
  multiline?: boolean;
  rows?: number;
  style?: React.CSSProperties;
  inputStyle?: React.CSSProperties;
}

export declare function TextField(props: TextFieldProps): React.JSX.Element;
