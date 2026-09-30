import * as React from 'react';

/** Numeric +/- control, e.g. attempts in the log sheet. */
export interface StepperProps {
  value?: number;
  onChange?: (v: number) => void;
  min?: number;
  max?: number;
  label?: string;
  size?: 'md' | 'lg';
  style?: React.CSSProperties;
}

export declare function Stepper(props: StepperProps): React.JSX.Element;
