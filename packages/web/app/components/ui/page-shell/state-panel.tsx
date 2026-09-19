import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import PageCard from './page-card';
import { themeTokens } from '@/app/theme/theme-config';

export type StatePanelTone = 'brand' | 'warning';

export type StatePanelProps = {
  /** `warning` for "something is broken", `brand` for "nothing here yet". */
  tone: StatePanelTone;
  icon: React.ReactElement<{ sx?: object }>;
  title: string;
  body: string;
  /** Buttons. Rendered in a centred wrapping row; see the 44px note below. */
  actions: React.ReactNode;
};

/**
 * The empty/error panel: a ringed glyph, a title, a line of body, and a row of
 * actions on an elevated card.
 *
 * It lived inside `gyms/directory-page.tsx` as a module-local function, which is
 * why /playlists grew a worse hand-rolled copy of the same thing instead of
 * reusing it. Nothing about it is gym-specific, so it lives with the rest of the
 * page primitives now.
 *
 * Server-safe on purpose — no `'use client'`. Both of its callers render on the
 * server, and an empty state that needs hydration to appear is an empty state
 * that flashes.
 */
export default function StatePanel({ tone, icon, title, body, actions }: StatePanelProps) {
  const glyphColor = tone === 'warning' ? 'var(--color-warning)' : 'var(--color-primary)';

  return (
    <PageCard
      variant="elevated"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        py: 5,
        my: 2,
      }}
    >
      <Box
        aria-hidden="true"
        sx={{
          width: 52,
          height: 52,
          borderRadius: 'var(--border-radius-full)',
          backgroundColor: 'var(--semantic-surface)',
          // Decorative ring around a glyph, not a control boundary — `--separator`
          // is the right token here even though the buttons below use
          // `--control-border`.
          border: '1px solid var(--separator)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: glyphColor,
          mb: 2,
        }}
      >
        {React.cloneElement(icon, { sx: { fontSize: 24 } })}
      </Box>
      <Typography variant="h6" component="p" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1, maxWidth: '46ch' }}>
        {body}
      </Typography>
      <Box
        sx={{
          display: 'flex',
          gap: 1.5,
          flexWrap: 'wrap',
          justifyContent: 'center',
          mt: 2.5,
          // Callers pass plain MUI Buttons, which are 40px at sizeMedium — under
          // the 44px target the rest of the site holds itself to. Floored here so
          // every panel clears it without each caller having to remember.
          '& .MuiButton-root': { minHeight: 44 },
        }}
      >
        {actions}
      </Box>
    </PageCard>
  );
}
