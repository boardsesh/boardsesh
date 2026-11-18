import React from 'react';
import Box from '@mui/material/Box';
import { themeTokens } from '@/app/theme/theme-config';

/** Distinguish an app control's exact name from the sentence around it. */
export default function UiLabel({ children }: { children?: React.ReactNode }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline',
        px: 0.75,
        py: 0.25,
        borderRadius: 1,
        backgroundColor: themeTokens.semantic.inputSurface,
        color: themeTokens.neutral[900],
        fontWeight: themeTokens.typography.fontWeight.medium,
      }}
    >
      {children}
    </Box>
  );
}
