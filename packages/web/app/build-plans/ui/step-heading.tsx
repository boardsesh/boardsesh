import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import styles from './build-plans-ui.module.css';

/**
 * A numbered step inside the configurator.
 *
 * The numerals are the only ones on this surface, and they are here because the
 * configurator really is a sequence: what you cut, how your shop cuts it, what
 * it says, then the preview, then the licence. Nothing else on `/build-plans`
 * gets numbered — a number that is not a sequence is decoration.
 *
 * `done` fills the marker so a buyer scrolling back can see what they have
 * already answered without re-reading it.
 */
export type StepHeadingProps = {
  /** 1-based. Renders as-is; the caller owns the numbering. */
  step: number;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Filled marker: this step is answered. */
  done?: boolean;
  id?: string;
  headingLevel?: 'h2' | 'h3' | 'h4';
};

export default function StepHeading({
  step,
  title,
  description,
  done = false,
  id,
  headingLevel = 'h3',
}: StepHeadingProps) {
  return (
    <Box className={styles.step} id={id}>
      <Box aria-hidden className={`${styles.stepNumber} ${done ? styles.stepDone : ''}`}>
        {step}
      </Box>
      <Box>
        <Typography variant="h4" component={headingLevel} className={styles.stepTitle}>
          {title}
        </Typography>
        {description ? (
          <Typography variant="body2" component="p" className={styles.stepDescription}>
            {description}
          </Typography>
        ) : null}
      </Box>
    </Box>
  );
}
