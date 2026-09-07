import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import styles from './build-plans-ui.module.css';

/**
 * Nothing here yet, and what to do about it.
 *
 * Not `components/ui/empty-state.tsx`: that one is a centred client component
 * with an inbox icon, built for a panel inside an app screen. The build-plans
 * empty states are server-rendered, left-aligned like the copy above them, and
 * always carry an action — an empty orders list is an invitation to configure a
 * wall, not a notice that a query returned nothing.
 *
 * A dashed border rather than a solid one: it says "a card belongs here" without
 * pretending to be one.
 */
export type EmptyPanelProps = {
  title: React.ReactNode;
  body?: React.ReactNode;
  /** The way out. An empty state without one is a dead end. */
  action?: React.ReactNode;
};

export default function EmptyPanel({ title, body, action }: EmptyPanelProps) {
  return (
    <Box className={styles.empty}>
      <Typography variant="h4" component="p" className={styles.emptyTitle}>
        {title}
      </Typography>
      {body ? (
        <Typography variant="body2" component="p" className={styles.emptyBody}>
          {body}
        </Typography>
      ) : null}
      {action ? <Box className={styles.emptyAction}>{action}</Box> : null}
    </Box>
  );
}
