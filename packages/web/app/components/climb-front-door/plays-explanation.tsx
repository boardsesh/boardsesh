import type { ReactNode } from 'react';
import Typography from '@mui/material/Typography';
import { themeTokens } from '@/app/theme/theme-config';

const explanationSx = {
  my: `${themeTokens.spacing[2]}px`,
  color: 'var(--neutral-500)',
} as const;

export default function PlaysExplanation({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <Typography component="p" variant="body2" id={id} sx={explanationSx}>
      {children}
    </Typography>
  );
}
