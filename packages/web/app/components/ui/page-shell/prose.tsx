import React from 'react';
import Typography from '@mui/material/Typography';
import styles from './page-shell.module.css';

/** A body paragraph at the shell's reading measure and vertical rhythm. */
export function Prose({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="body1" component="p" className={styles.paragraph}>
      {children}
    </Typography>
  );
}

/** A bulleted or numbered list matching Prose's rhythm. */
export function ProseList({ ordered = false, children }: { ordered?: boolean; children: React.ReactNode }) {
  return (
    <Typography variant="body1" component={ordered ? 'ol' : 'ul'} className={styles.list}>
      {children}
    </Typography>
  );
}
