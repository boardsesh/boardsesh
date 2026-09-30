import * as React from 'react';

/** Beta video thumbnail with play affordance and duration. */
export interface VideoThumbProps {
  title?: string;
  author?: string;
  duration?: string;
  meta?: string;
  src?: string;
  aspect?: string;
  onClick?: () => void;
  style?: React.CSSProperties;
}

export declare function VideoThumb(props: VideoThumbProps): React.JSX.Element;
