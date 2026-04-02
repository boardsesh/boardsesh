import React from 'react';
import Box from '@mui/material/Box';
import { themeTokens } from '@/app/theme/theme-config';

export default function NotificationsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Box sx={{ minHeight: '100dvh', pt: 'var(--global-header-height)', pb: themeTokens.layout.bottomNavSpacer }}>
      {children}
    </Box>
  );
}
