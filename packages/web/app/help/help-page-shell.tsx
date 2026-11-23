import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import HelpJumpNav from './help-jump-nav';
import styles from './help-page-shell.module.css';

export type HelpJumpLink = { id: string; label: string };

export type HelpPageShellProps = {
  /** The page's one <h1>. */
  title: string;
  /** One sentence under the title. */
  lead: string;
  /** HelpBreadcrumb on a guide page; the hub has none. */
  breadcrumb?: React.ReactNode;
  /** Chips under the lead that jump to a section on this page. Five at most. */
  jumpLinks: readonly HelpJumpLink[];
  /** Accessible name of the chip row, already resolved by the caller's `t()`. */
  jumpLabel: string;
  /** `HelpBand`s. */
  children: React.ReactNode;
};

/**
 * The frame every /help page sits in: a hero on the violet chrome, then the
 * guide's bands on the page surface (`--semantic-background`).
 *
 * Help used the shared PageShell until the "Showcase" redesign. Its prose
 * measure and single column cannot hold a band that puts a phone beside the
 * copy, so help owns its frame now; /about, /legal and /privacy keep PageShell.
 *
 * The jump chips replace the hub's old sticky topics rail. They are plain
 * anchors, so they work before hydration and on every guide page alike.
 *
 * Server-safe: no hooks, strings arrive resolved.
 */
export default function HelpPageShell({ title, lead, breadcrumb, jumpLinks, jumpLabel, children }: HelpPageShellProps) {
  return (
    <Box component="main" className={styles.page}>
      <Box component="header" className={styles.hero}>
        <Box className={styles.heroInner}>
          {breadcrumb ? <Box className={styles.breadcrumb}>{breadcrumb}</Box> : null}
          <Typography variant="h2" component="h1" className={`${styles.title} ${breadcrumb ? styles.guideTitle : ''}`}>
            {title}
          </Typography>
          <Typography variant="body1" component="p" className={styles.lead}>
            {lead}
          </Typography>
        </Box>
      </Box>
      {jumpLinks.length > 0 ? <HelpJumpNav links={jumpLinks} label={jumpLabel} /> : null}
      <Box className={styles.read}>{children}</Box>
    </Box>
  );
}
