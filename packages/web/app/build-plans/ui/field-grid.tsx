import React from 'react';
import Box from '@mui/material/Box';
import styles from './build-plans-ui.module.css';

/**
 * The configurator's field layout.
 *
 * `auto-fit, minmax(220px, 1fr)` rather than a fixed column count: eleven
 * selects in one column is a very long scroll on a laptop, and two forced
 * columns is a squeeze inside the 1fr half of the split layout. The row gap is
 * 20px so a helper text under one field never touches the label of the next.
 *
 * `columns="single"` for the fields that must stay full width — a text input
 * whose value is a sentence, a placement canvas.
 */
export type FieldGridProps = {
  children: React.ReactNode;
  columns?: 'auto' | 'single';
};

export default function FieldGrid({ children, columns = 'auto' }: FieldGridProps) {
  return <Box className={`${styles.fields} ${columns === 'single' ? styles.fieldsSingle : ''}`}>{children}</Box>;
}
