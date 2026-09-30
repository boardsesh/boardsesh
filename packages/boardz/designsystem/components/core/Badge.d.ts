import * as React from 'react';

/** Small status label. `mono` + `outline` is the Graphite tag (BENCHMARK, 40°, BM). */
export interface BadgeProps {
  children?: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'success' | 'danger' | 'warning' | 'info' | 'inverse';
  /** xs 16 (inline in rows) · sm 20 · md 24 */
  size?: 'xs' | 'sm' | 'md';
  /** Hairline ring instead of a fill */
  outline?: boolean;
  /** Leading status dot — glows as an LED for success/danger/warning/info */
  dot?: boolean;
  /** Mono, uppercase, tracked */
  mono?: boolean;
  style?: React.CSSProperties;
}

export declare function Badge(props: BadgeProps): React.JSX.Element;
