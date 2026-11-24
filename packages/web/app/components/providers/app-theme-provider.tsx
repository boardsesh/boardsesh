'use client';

import React from 'react';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { darkTheme } from '@/app/theme/mui-theme';

// The web app renders one theme: Velvet Send dark. The light scheme and the
// colour-mode switch came out with #4467 (the climbing-UI teardown) — www is a
// marketing surface now, and it is dark everywhere.
//
// Date adapters live with the picker surfaces so marketing pages load only
// their theme and baseline styles.
export default function AppThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={darkTheme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}
