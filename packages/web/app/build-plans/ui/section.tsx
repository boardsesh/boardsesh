import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import styles from './build-plans-ui.module.css';

/**
 * A top-level page section: heading, optional standfirst, optional action on
 * the same baseline, then the content.
 *
 * Sections carry no margin of their own — `PageFrame` owns the gap between
 * them, so nothing here can cancel out someone else's spacing.
 */
export type PageSectionProps = {
  /** Anchor target. `/build-plans#configure` scrolls here. */
  id?: string;
  title: React.ReactNode;
  /** One line under the heading saying what the section is for. */
  intro?: React.ReactNode;
  /** A link or small button on the heading's baseline, right-aligned. */
  action?: React.ReactNode;
  /** `h2` on a page whose `h1` is the page title. `h3` inside another section. */
  headingLevel?: 'h2' | 'h3';
  children: React.ReactNode;
};

export default function PageSection({ id, title, intro, action, headingLevel = 'h2', children }: PageSectionProps) {
  return (
    <Box component="section" id={id}>
      <Box className={styles.sectionHead}>
        <Box>
          <Typography variant="h2" component={headingLevel} className={styles.sectionHeading}>
            {title}
          </Typography>
          {intro ? (
            <Typography variant="body1" component="p" className={styles.sectionIntro}>
              {intro}
            </Typography>
          ) : null}
        </Box>
        {action}
      </Box>
      <Box className={styles.sectionBody}>{children}</Box>
    </Box>
  );
}
