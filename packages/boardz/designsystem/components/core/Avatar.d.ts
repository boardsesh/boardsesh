import * as React from 'react';

/** Climber avatar with initials fallback. */
export interface AvatarProps {
  name?: string;
  src?: string;
  size?: number;
  ring?: string;
  style?: React.CSSProperties;
}

export declare function Avatar(props: AvatarProps): React.JSX.Element;
