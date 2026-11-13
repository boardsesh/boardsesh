import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import styles from './build-plans-ui.module.css';

/**
 * The cut list, and everything shaped like it: label on the left, figure on the
 * right, a hairline between rows.
 *
 * Figures are tabular, so a column of millimetres and hole counts lines up
 * instead of dancing. That is the whole reason this is a component and not a
 * `Stack` of rows — the summary, the order page and the tier cards all show
 * numbers, and they must all line up the same way.
 *
 * `layout="stacked"` puts the value under the label for rows whose value is a
 * sentence rather than a figure.
 */
export type KeyValueItem = {
  /** React key. Stable across renders — not the index. */
  key: string;
  label: React.ReactNode;
  value: React.ReactNode;
  /** A quiet line under the row. Use sparingly; most rows do not need one. */
  hint?: React.ReactNode;
};

export type KeyValueListProps = {
  items: readonly KeyValueItem[];
  /** Two columns of rows once there is room (700px). One below that. */
  columns?: 1 | 2;
  /** `stacked` for sentence values; `row` (default) for figures. */
  layout?: 'row' | 'stacked';
  /** Tighter rows for a sticky rail where vertical space is the constraint. */
  dense?: boolean;
  'aria-label'?: string;
};

export default function KeyValueList({
  items,
  columns = 1,
  layout = 'row',
  dense = false,
  'aria-label': ariaLabel,
}: KeyValueListProps) {
  const classNames = [
    styles.kv,
    columns === 2 ? styles.kvTwoUp : '',
    layout === 'stacked' ? styles.kvStacked : '',
    dense ? styles.kvDense : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Box component="dl" className={classNames} aria-label={ariaLabel}>
      {items.map((item) => (
        <Box key={item.key} className={styles.kvRow}>
          <Typography variant="body2" component="dt" className={styles.kvLabel}>
            {item.label}
          </Typography>
          {/* The value is plain text in the `dd`, not a nested `Typography`:
              MUI's body2 variant sets `fontWeight: 400`, which would land
              inside this element and undo the 600 that makes a figure read as
              a figure. The `dd` carries the type itself. */}
          <Box component="dd" className={styles.kvValue}>
            {item.value}
            {item.hint ? (
              <Typography variant="caption" component="p" className={styles.kvHint}>
                {item.hint}
              </Typography>
            ) : null}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
