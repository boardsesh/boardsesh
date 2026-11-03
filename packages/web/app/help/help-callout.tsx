import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import styles from './help-blocks.module.css';

export type HelpCalloutProps = {
  /** Optional bold first line, already resolved by the caller's `t()`. */
  title?: string;
  /** The fact itself: a string, or inline text with links. */
  children: React.ReactNode;
};

/**
 * One fact on a help page that the reader must not miss: a permission prompt,
 * a step that cannot be undone, a default that surprises people.
 *
 * Use at most one or two per page; a page of callouts is a page with none.
 * Renders a `role="note"` block with a slate-violet edge (`--color-info`). The
 * icon is decorative. Server-safe: no hooks, strings arrive resolved.
 *
 * @example
 * <HelpCallout>{t('help.bluetooth.connect.p2')}</HelpCallout>
 */
export default function HelpCallout({ title, children }: HelpCalloutProps) {
  return (
    <Box role="note" className={styles.callout}>
      <InfoOutlined aria-hidden="true" className={styles.calloutIcon} />
      <Box>
        {title ? (
          <Typography component="p" className={styles.calloutTitle}>
            {title}
          </Typography>
        ) : null}
        <Typography component="div" variant="body1" className={styles.calloutBody}>
          {children}
        </Typography>
      </Box>
    </Box>
  );
}
