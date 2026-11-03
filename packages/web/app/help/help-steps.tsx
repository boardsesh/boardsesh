import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import styles from './help-blocks.module.css';

export type HelpStepsProps = {
  /** One entry per step, in order, each already resolved by the caller's `t()`. */
  steps: readonly React.ReactNode[];
};

/**
 * Numbered steps for a task done in order ("tap Share, pick Boardsesh, tap the
 * climb"). Each numeral sits in a ring beside its step, so a reader glancing
 * back from their phone finds their place.
 *
 * Only for a real sequence. A set of options or menu rows is a `ProseList`;
 * numbering it tells the reader there is an order when there is none.
 * Renders a real `<ol>` (with `role="list"`, which Safari drops once the
 * markers are hidden), so screen readers still hear "1 of 3". Server-safe.
 *
 * @example
 * <HelpSteps steps={[t('help.betaVideos.share.step1'), t('help.betaVideos.share.step2')]} />
 */
export default function HelpSteps({ steps }: HelpStepsProps) {
  return (
    <Box component="ol" role="list" className={styles.steps}>
      {steps.map((step, index) => (
        // Steps are a fixed, ordered list from the page source; the position is the identity.
        // oxlint-disable-next-line react/no-array-index-key
        <li key={index} className={styles.step}>
          <span aria-hidden="true" className={styles.stepNumber}>
            {index + 1}
          </span>
          <Typography component="div" variant="body1" className={styles.stepBody}>
            {step}
          </Typography>
        </li>
      ))}
    </Box>
  );
}
