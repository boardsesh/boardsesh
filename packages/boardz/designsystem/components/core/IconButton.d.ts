import * as React from 'react';

/** Square icon-only button. `active` fills the glyph (favorite, bookmarked). Always pass `label`. */
export interface IconButtonProps {
  icon: string;
  label: string;
  variant?: 'ghost' | 'secondary' | 'tonal' | 'primary';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  active?: boolean;
  /** Defaults to ink. Keep it monochrome unless the glyph must carry status. */
  activeColor?: string;
  round?: boolean;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
}

export declare function IconButton(props: IconButtonProps): React.JSX.Element;
