import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import styles from './build-plans-ui.module.css';

/**
 * A price, and the one line of small print that has to sit with it.
 *
 * Takes an already-formatted string rather than cents: the catalogue's currency
 * and the request's locale both live at the call site, and `formatPrice` in
 * `configurator-state.ts` is the one formatter. Passing cents here would mean a
 * second one.
 *
 * The figure is tabular so two tiers side by side line up on the decimal.
 */
export type PriceTagProps = {
  /** Formatted by `formatPrice(amountCents, currency, locale)`. */
  amount: React.ReactNode;
  /** "per wall", "pay when you finalise". One short line. */
  note?: React.ReactNode;
  /** `lg` for the one price a page is really about. */
  size?: 'md' | 'lg';
};

export default function PriceTag({ amount, note, size = 'md' }: PriceTagProps) {
  return (
    <Box className={`${styles.price} ${size === 'lg' ? styles.priceLarge : ''}`}>
      <Typography variant="h4" component="p" className={styles.priceAmount}>
        {amount}
      </Typography>
      {note ? (
        <Typography variant="body2" component="p" className={styles.priceNote}>
          {note}
        </Typography>
      ) : null}
    </Box>
  );
}
