import * as React from 'react';

/** LED ring swatch for a hold role; use in legends. */
export interface HoldMarkerProps {
  role?: 'start' | 'hand' | 'foot' | 'finish';
  board?: 'moon' | 'kilter' | 'tension';
  size?: number;
  label?: string | boolean;
  lit?: boolean;
  style?: React.CSSProperties;
}

export declare function HoldMarker(props: HoldMarkerProps): React.JSX.Element;
