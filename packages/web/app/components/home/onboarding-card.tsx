import React from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import Typography from '@mui/material/Typography';
import { themeTokens } from '@/app/theme/theme-config';
import LocaleLink from '@/app/components/i18n/locale-link';

export type OnboardingCardAccent = 'action' | 'social' | 'help' | 'v11' | 'v12' | 'v13' | 'none';

export type OnboardingCardProps = {
  icon: React.ReactNode;
  title: string;
  description: string;
  /** Destination. Makes the whole card a real anchor a crawler can follow. */
  href?: string;
  /** `href` is cross-origin (the app, Discord) — render a plain <a>, not a LocaleLink. */
  external?: boolean;
  /** Open an external card in a new tab. Off for the app hand-off, which is a same-tab
   *  navigation between two `.boardsesh.com` origins (see start-climbing-button.tsx). */
  newTab?: boolean;
  /** Fallback for the store-install cards, which fire analytics and window.open. */
  onClick?: () => void;
  /**
   * Category colour-coding for the icon chip. Cards that do similar jobs
   * share an accent so the list is scannable. The whole card remains the
   * CTA — the chip colour is metadata, not a CTA token. Defaults to
   * 'action' (rose) for backwards compatibility.
   */
  accent?: OnboardingCardAccent;
};

// Soft tint backgrounds (~10% alpha) for each accent. Inlined rather than
// added as CSS vars — these only render here. The v11/v12/v13 accents tie
// the onboarding stack to the project-zone V-grade scale that the brand
// mark is built on (see designer brief §2a).
const accentSurface: Record<OnboardingCardAccent, string> = {
  action: 'var(--semantic-selected-light)', // existing rose tint
  social: 'rgba(156, 39, 176, 0.10)', // V11 purple
  help: themeTokens.colors.infoTint, // violet-slate (Velvet info) — same family as the rest
  v11: 'rgba(156, 39, 176, 0.10)', // V11 #9C27B0
  v12: 'rgba(123, 31, 162, 0.10)', // V12 #7B1FA2
  v13: 'rgba(106, 27, 154, 0.10)', // V13 #6A1B9A
  none: 'transparent',
};

function resolveAccentIconColor(accent: OnboardingCardAccent): string {
  switch (accent) {
    case 'social':
      return themeTokens.colors.purple;
    case 'help':
      return 'var(--color-info)';
    case 'v11':
      return '#9C27B0';
    case 'v12':
      return '#7B1FA2';
    case 'v13':
      return '#6A1B9A';
    case 'none':
      return 'inherit';
    case 'action':
    default:
      return 'var(--color-primary)';
  }
}

export default function OnboardingCard({
  icon,
  title,
  description,
  onClick,
  href,
  external,
  newTab,
  accent = 'action',
}: OnboardingCardProps) {
  const cardBody = (
    <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 2, px: 2.5 }}>
      <Box
        sx={{
          width: 44,
          height: 44,
          borderRadius: `${themeTokens.borderRadius.md}px`,
          backgroundColor: accentSurface[accent],
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          color: resolveAccentIconColor(accent),
        }}
      >
        {icon}
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography
          variant="body1"
          fontWeight={themeTokens.typography.fontWeight.semibold}
          sx={{
            color: 'var(--neutral-900)',
            lineHeight: themeTokens.typography.lineHeight.tight,
          }}
        >
          {title}
        </Typography>
        <Typography variant="body2" sx={{ color: 'var(--neutral-500)', mt: 0.25 }}>
          {description}
        </Typography>
      </Box>
    </CardContent>
  );

  // A card that goes somewhere is an anchor, not a click handler on a div:
  // that is what makes it crawlable, middle-clickable and keyboard-reachable.
  const action = external ? (
    <CardActionArea
      component="a"
      href={href}
      target={newTab ? '_blank' : undefined}
      rel={newTab ? 'noopener noreferrer' : undefined}
      sx={{ p: 0 }}
    >
      {cardBody}
    </CardActionArea>
  ) : href ? (
    <CardActionArea component={LocaleLink} href={href} sx={{ p: 0 }}>
      {cardBody}
    </CardActionArea>
  ) : (
    <CardActionArea onClick={onClick} sx={{ p: 0 }}>
      {cardBody}
    </CardActionArea>
  );

  return (
    <Card
      variant="outlined"
      sx={{
        borderRadius: `${themeTokens.borderRadius.lg}px`,
        border: '1px solid var(--neutral-200)',
        transition: themeTokens.transitions.fast,
        '&:hover': {
          borderColor: 'var(--neutral-300)',
          boxShadow: themeTokens.shadows.sm,
        },
      }}
    >
      {action}
    </Card>
  );
}
