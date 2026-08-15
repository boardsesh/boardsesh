'use client';

// Screen-only bar under the poster: open the print dialog, or go back to the
// gym page. `@media print` in the stylesheet removes it, so nothing here ends
// up on paper.

import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import PrintOutlined from '@mui/icons-material/PrintOutlined';
import ArrowBackOutlined from '@mui/icons-material/ArrowBackOutlined';
import LocaleLink from '@/app/components/i18n/locale-link';
import styles from './gym-poster.module.css';

type GymPosterPrintBarProps = {
  gymHref: string;
  /**
   * Already translated by the server component that renders this island — the
   * same arrangement `GymInstallCta` uses, so a static poster page doesn't drag
   * the client i18n bundle along for two button labels.
   */
  printLabel: string;
  backLabel: string;
};

export default function GymPosterPrintBar({ gymHref, printLabel, backLabel }: GymPosterPrintBarProps) {
  return (
    <Box className={styles.noPrint}>
      <Button
        variant="contained"
        startIcon={<PrintOutlined />}
        onClick={() => window.print()}
        sx={{ textTransform: 'none' }}
      >
        {printLabel}
      </Button>
      <Button
        component={LocaleLink}
        href={gymHref}
        variant="outlined"
        startIcon={<ArrowBackOutlined />}
        sx={{ textTransform: 'none' }}
      >
        {backLabel}
      </Button>
    </Box>
  );
}
