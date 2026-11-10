'use client';

import React, { useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlineOutlined from '@mui/icons-material/ErrorOutlineOutlined';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import Logo from '@/app/components/brand/logo';
import { themeTokens } from '@/app/theme/theme-config';

/**
 * The frame both partner OAuth pages share. No site navigation: a link away
 * from here loses the app's request, and the Boardsesh mark at the top is the
 * one thing the climber should recognise. The route is chrome-less, so the
 * marketing header, footer and analytics banner stay off it.
 */
export function PartnerOAuthShell({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        minHeight: '100dvh',
        background: 'var(--semantic-background)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box
        component="header"
        sx={{
          height: 64,
          px: 2,
          display: 'flex',
          alignItems: 'center',
          justifyContent: { xs: 'flex-start', sm: 'center' },
          background: 'var(--semantic-surface)',
          borderBottom: `1px solid ${themeTokens.semantic.separator}`,
        }}
      >
        <Logo size="sm" linkToHome={false} />
      </Box>
      <Box
        component="main"
        sx={{
          flex: 1,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
          px: 2,
          py: { xs: 3, sm: 6 },
        }}
      >
        <Card sx={{ width: '100%', maxWidth: 440 }}>
          <CardContent sx={{ p: { xs: 3, sm: 4 }, '&:last-child': { pb: { xs: 3, sm: 4 } } }}>{children}</CardContent>
        </Card>
      </Box>
    </Box>
  );
}

type PartnerOAuthTitleProps = {
  children: React.ReactNode;
  /**
   * Move focus here when this title appears after the page changed state, so a
   * screen reader announces the new state. Never on the first render: a page
   * load should not move focus.
   */
  focusOnMount?: boolean;
};

/** The page's one `h1`. Focusable from script only, so it can receive focus on a state change. */
export function PartnerOAuthTitle({ children, focusOnMount = false }: PartnerOAuthTitleProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) headingRef.current?.focus();
  }, [focusOnMount]);
  return (
    <Typography
      ref={headingRef}
      variant="h3"
      component="h1"
      tabIndex={-1}
      sx={{ outline: 'none', overflowWrap: 'anywhere' }}
    >
      {children}
    </Typography>
  );
}

export type PartnerOAuthTone = 'info' | 'problem' | 'done';

const TONE_ICONS = {
  info: { Icon: InfoOutlined, color: themeTokens.colors.primary },
  problem: { Icon: ErrorOutlineOutlined, color: themeTokens.colors.warning },
  done: { Icon: CheckCircleOutlined, color: themeTokens.colors.success },
} as const;

type PartnerOAuthMessageProps = {
  tone: PartnerOAuthTone;
  title: React.ReactNode;
  body: React.ReactNode;
  /** Buttons or links below the text. */
  actions?: React.ReactNode;
  focusOnMount?: boolean;
};

/**
 * A state with nothing to decide: an error, an expired link, a finished answer.
 * The icon repeats what the title says and is hidden from screen readers.
 */
export function PartnerOAuthMessage({ tone, title, body, actions, focusOnMount }: PartnerOAuthMessageProps) {
  const { Icon, color } = TONE_ICONS[tone];
  return (
    <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
      <Icon aria-hidden sx={{ fontSize: 40, color }} />
      <PartnerOAuthTitle focusOnMount={focusOnMount}>{title}</PartnerOAuthTitle>
      <Typography variant="body1" color="text.secondary">
        {body}
      </Typography>
      {actions ? (
        <Stack spacing={1.5} sx={{ width: '100%', pt: 1 }}>
          {actions}
        </Stack>
      ) : null}
    </Stack>
  );
}
