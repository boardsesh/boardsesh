import React from 'react';
import Box from '@mui/material/Box';
import styles from './hold-ring.module.css';

export type HoldRole = 'start' | 'hand' | 'finish' | 'foot' | 'unlit';
export type HoldRingSize = 'xs' | 'default' | 'sm' | 'md' | 'number';

/**
 * A lit hold, drawn as the board shows it. Decorative: always `aria-hidden`, and
 * always next to words that say the same thing, so colour is never the only signal.
 * The fixed meaning across every page: start = Boardsesh does it better, finish =
 * only in Boardsesh, hand = same in both, foot = the other app does it better.
 */
export default function HoldRing({
  role,
  size = 'default',
  className,
  children,
}: {
  role: HoldRole;
  size?: HoldRingSize;
  className?: string;
  /** A step number, for `size="number"`. */
  children?: React.ReactNode;
}) {
  const classes = [styles.ring, styles[role], size === 'default' ? null : styles[size], className]
    .filter(Boolean)
    .join(' ');
  return (
    <Box component="span" aria-hidden="true" className={classes}>
      {children}
    </Box>
  );
}
