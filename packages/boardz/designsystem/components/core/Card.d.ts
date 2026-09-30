import * as React from 'react';

/** Hairline panel. No shadows at rest — elevation is reserved for sheets and toasts. */
export interface CardProps {
  children?: React.ReactNode;
  padding?: number | string;
  /** Hover darkens the hairline */
  interactive?: boolean;
  /** 1.5px ink ring */
  selected?: boolean;
  /** Transparent fill, hairline only (sits on paper) */
  flat?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
}

export declare function Card(props: CardProps): React.JSX.Element;
