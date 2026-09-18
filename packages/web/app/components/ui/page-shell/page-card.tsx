import React from 'react';
import Box from '@mui/material/Box';
import styles from './page-shell.module.css';

export type PageCardProps = {
  /**
   * `surface` sits on the page ground; `elevated` sits on top of another
   * surface, or is used when the card has to be the findable thing on the page.
   */
  variant?: 'surface' | 'elevated';
  padding?: 'sm' | 'md';
  className?: string;
  children: React.ReactNode;
} & Omit<React.ComponentProps<typeof Box>, 'className' | 'children'>;

/**
 * A card for something you can ACT on. Prose does not get a card — that was the
 * old /support page's whole problem: an entire document inside one Paper.
 */
export default function PageCard({
  variant = 'surface',
  padding = 'md',
  className,
  children,
  ...boxProps
}: PageCardProps) {
  const classes = [
    styles.card,
    variant === 'elevated' ? styles.cardElevated : null,
    padding === 'sm' ? styles.cardPaddingSm : styles.cardPaddingMd,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Box className={classes} {...boxProps}>
      {children}
    </Box>
  );
}
