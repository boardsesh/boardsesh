import * as React from 'react';

/**
 * Buttons. Primary is ink (paper in dark). One primary per view.
 * Use `led` on the action that lights the board — it swaps the icon for a glowing LED dot.
 */
export interface ButtonProps {
  children?: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'tonal' | 'ghost' | 'danger';
  /** sm 32 · md 40 · lg 48 · xl 56 (board mode on tablet) */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Lucide icon name (kebab-case) before the label */
  icon?: string;
  iconRight?: string;
  /** true = board hand-hold color; or any CSS color */
  led?: boolean | string;
  fullWidth?: boolean;
  loading?: boolean;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  type?: 'button' | 'submit';
  style?: React.CSSProperties;
}

export declare function Button(props: ButtonProps): React.JSX.Element;
