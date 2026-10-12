import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import styles from './build-plans-ui.module.css';

/**
 * The one card on this surface.
 *
 * Deliberately not MUI's `Card`: the theme gives every `Card` a resting shadow
 * and a hover shadow, which on a page made of a dozen panels reads as a stack
 * of floating tiles. Here a card is a flat, hairline-bordered sheet — the same
 * radius and border as the rest of www — and a shadow means one thing only:
 * this surface floats (the sticky summary rail).
 *
 * `tone="accent"` is the exception, and it is a rule down the leading edge
 * rather than a coloured fill: it marks the one card the page wants acted on
 * (the ready preview, the chosen tier).
 */
export type SectionCardProps = {
  id?: string;
  title?: React.ReactNode;
  /** One line under the title. Longer than that and it belongs in the body. */
  description?: React.ReactNode;
  /** A button, chip or link on the title's row. */
  action?: React.ReactNode;
  /** `quiet` sits back (contact panels, footnotes); `raised` floats; `accent` asks to be acted on. */
  tone?: 'default' | 'quiet' | 'raised' | 'accent';
  /** `flush` when the child paints its own edges (an image, a full-bleed table). */
  padding?: 'default' | 'tight' | 'flush';
  /** Heading element. Match the page's outline; the visual size does not change. */
  headingLevel?: 'h2' | 'h3' | 'h4';
  component?: React.ElementType;
  /**
   * Escape hatch for one thing only: a page-level class the card cannot know
   * about (an anchor's `scroll-margin-top`, a grid-area). Not for restyling the
   * card — if a card needs a different surface, it needs a new `tone`.
   */
  className?: string;
  children?: React.ReactNode;
};

const TONE_CLASS: Record<NonNullable<SectionCardProps['tone']>, string> = {
  default: '',
  quiet: styles.cardQuiet,
  raised: styles.cardRaised,
  accent: styles.cardAccent,
};

const PADDING_CLASS: Record<NonNullable<SectionCardProps['padding']>, string> = {
  default: '',
  tight: styles.cardTight,
  flush: styles.cardFlush,
};

export default function SectionCard({
  id,
  title,
  description,
  action,
  tone = 'default',
  padding = 'default',
  headingLevel = 'h3',
  component = 'div',
  className,
  children,
}: SectionCardProps) {
  const hasHead = Boolean(title || description || action);
  return (
    <Box
      component={component}
      id={id}
      className={[styles.card, TONE_CLASS[tone], PADDING_CLASS[padding], className].filter(Boolean).join(' ')}
    >
      {hasHead ? (
        <Box className={styles.cardHead}>
          <Box>
            {title ? (
              <Typography variant="h4" component={headingLevel} className={styles.cardTitle}>
                {title}
              </Typography>
            ) : null}
            {description ? (
              <Typography variant="body2" component="p" className={styles.cardDescription}>
                {description}
              </Typography>
            ) : null}
          </Box>
          {action}
        </Box>
      ) : null}
      {children ? <Box className={hasHead ? styles.cardContent : undefined}>{children}</Box> : null}
    </Box>
  );
}
