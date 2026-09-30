import * as React from 'react';

/** Sidebar (desktop) / rail (tablet) navigation row. */
export interface NavItemProps {
  icon: string;
  label: string;
  active?: boolean;
  count?: number;
  collapsed?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}

export declare function NavItem(props: NavItemProps): React.JSX.Element;
