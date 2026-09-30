import * as React from 'react';

/** On/off toggle; signal lime when on. With label renders a settings row. */
export interface SwitchProps {
  checked?: boolean;
  onChange?: (v: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}

export declare function Switch(props: SwitchProps): React.JSX.Element;
