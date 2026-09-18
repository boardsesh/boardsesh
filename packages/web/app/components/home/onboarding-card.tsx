import React from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import Typography from '@mui/material/Typography';
import { themeTokens } from '@/app/theme/theme-config';
import LocaleLink from '@/app/components/i18n/locale-link';

/**
 * What the card is FOR, not what colour it is. There used to be six accents
 * keyed to the V11-V13 project-zone purples; they were Material purples
 * (#9C27B0 / #7B1FA2 / #6A1B9A) rather than Velvet ones, and which card got
 * which grade said nothing about where the card went.
 */
export type OnboardingCardAccent = 'brand' | 'spark' | 'info' | 'none';

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
   * Which family the card belongs to, for the icon chip. Cards that do similar
   * jobs share an accent so the list is scannable. The whole card remains the
   * CTA — the chip colour is metadata, not a CTA token.
   */
  accent?: OnboardingCardAccent;
};

const accentSurface: Record<OnboardingCardAccent, string> = {
  brand: 'var(--home-accent-brand-surface)',
  spark: 'var(--home-accent-spark-surface)',
  info: 'var(--home-accent-info-surface)',
  none: 'transparent',
};

function resolveAccentIconColor(accent: OnboardingCardAccent): string {
  switch (accent) {
    case 'spark':
      // Amber is fill-only in Velvet Send, so on a tint it is the GLYPH that
      // carries it, never a filled chip with amber behind pale text.
      return 'var(--color-accent)';
    case 'info':
      return 'var(--color-info)';
    case 'none':
      return 'inherit';
    case 'brand':
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
  accent = 'brand',
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
        // A card needs a FILL on the dark ground: a bare hairline outline on
        // #110A20 is nearly invisible, and depth here is a lighter violet
        // rather than a shadow.
        backgroundColor: 'var(--semantic-surface)',
        border: '1px solid var(--separator)',
        transition: themeTokens.transitions.fast,
        '&:hover': {
          backgroundColor: 'var(--semantic-surface-elevated)',
          borderColor: 'var(--color-primary)',
        },
      }}
    >
      {action}
    </Card>
  );
}
