import React from 'react';
import Box from '@mui/material/Box';
import styles from './page-shell.module.css';

export type PageCardProps = {
  /**
   * `surface` sits on the page ground; `elevated` sits on top of another
   * surface, or is used when the card has to be the findable thing on the page.
   */
  variant?: 'surface' | 'elevated';
  /**
   * `lg` exists for the home feature strip, whose cards are the page's biggest
   * content blocks and carry a screenshot beside the copy. Adding a step is
   * cheaper than letting that strip keep its own card recipe.
   */
  padding?: 'sm' | 'md' | 'lg';
  /** `xl` goes with `padding="lg"` — a bigger card wants a bigger corner. */
  radius?: 'lg' | 'xl';
  className?: string;
  /**
   * The element to render. `Box`'s own `component` prop is generic and does not
   * survive `ComponentProps`, so it is declared here: the gym directory renders
   * each card as the `li` of a real list, and a div wrapped in an li would put
   * a non-list child inside a `ul`.
   */
  component?: React.ElementType;
  children: React.ReactNode;
  // `padding` is ALSO an MUI Box style prop. Without excluding it the two types
  // intersect and PageCard's own 'sm' | 'md' | 'lg' widens to Box's responsive
  // padding union, which then cannot index the class map.
} & Omit<React.ComponentProps<typeof Box>, 'className' | 'children' | 'component' | 'padding'>;

/**
 * A card for something you can ACT on. Prose does not get a card — that was the
 * old /support page's whole problem: an entire document inside one Paper.
 */
const PADDING_CLASS = {
  sm: 'cardPaddingSm',
  md: 'cardPaddingMd',
  lg: 'cardPaddingLg',
} as const;

export default function PageCard({
  variant = 'surface',
  padding = 'md',
  radius = 'lg',
  className,
  children,
  ...boxProps
}: PageCardProps) {
  const classes = [
    styles.card,
    variant === 'elevated' ? styles.cardElevated : null,
    styles[PADDING_CLASS[padding]],
    radius === 'xl' ? styles.cardRadiusXl : null,
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
