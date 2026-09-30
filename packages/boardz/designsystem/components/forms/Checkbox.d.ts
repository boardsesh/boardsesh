import * as React from 'react';

/** Checkbox with optional label and description. */
export interface CheckboxProps {
  checked?: boolean;
  onChange?: (v: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}

export declare function Checkbox(props: CheckboxProps): React.JSX.Element;
