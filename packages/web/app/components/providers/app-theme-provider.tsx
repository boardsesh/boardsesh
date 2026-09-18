'use client';

import React from 'react';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { darkTheme } from '@/app/theme/mui-theme';

// The web app renders one theme: Velvet Send dark. The light scheme and the
// colour-mode switch came out with #4467 (the climbing-UI teardown) — www is a
// marketing surface now, and it is dark everywhere.
//
// This provider is deliberately not just a ThemeProvider: it also owns
// CssBaseline and the MUI X date adapter, which is why the old
// ColorModeProvider was gutted rather than deleted.
export default function AppThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={darkTheme}>
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <CssBaseline />
        {children}
      </LocalizationProvider>
    </ThemeProvider>
  );
}
