import * as React from 'react';

/** Single radio option; group several with the same name. */
export interface RadioProps {
  checked?: boolean;
  onChange?: (value: string) => void;
  label?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}

export declare function Radio(props: RadioProps): React.JSX.Element;
