import * as React from 'react';

/** Quality rating (default 3 stars, board convention). Interactive when onChange is set. */
export interface StarRatingProps {
  value?: number;
  max?: number;
  size?: number;
  onChange?: (v: number) => void;
  style?: React.CSSProperties;
}

export declare function StarRating(props: StarRatingProps): React.JSX.Element;
