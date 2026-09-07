import React from 'react';
import Box from '@mui/material/Box';
import styles from './build-plans-ui.module.css';

/**
 * The configurator's shape: the form on the left, a summary that follows you on
 * the right.
 *
 * One column until 1000px, because a 320px rail beside a form of selects needs
 * a real laptop before either half is readable. On a phone the rail falls
 * underneath the form in DOM order — put it there deliberately, since that is
 * where a buyer meets it after answering the questions.
 *
 * The rail sticks under the fixed header, not to the viewport top, so it never
 * slides behind the site chrome.
 */
export type SplitLayoutProps = {
  /** The form. */
  children: React.ReactNode;
  /** What follows the reader: the cut summary, the price, the primary action. */
  rail: React.ReactNode;
  /** Names the rail for screen readers, e.g. "What gets cut". */
  railLabel: string;
};

export default function SplitLayout({ children, rail, railLabel }: SplitLayoutProps) {
  return (
    <Box className={styles.split}>
      <Box>{children}</Box>
      <Box component="aside" aria-label={railLabel} className={styles.rail}>
        {rail}
      </Box>
    </Box>
  );
}
