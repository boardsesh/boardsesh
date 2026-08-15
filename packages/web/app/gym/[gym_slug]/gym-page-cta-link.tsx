'use client';

import React from 'react';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import TvOutlined from '@mui/icons-material/TvOutlined';
import LanguageOutlined from '@mui/icons-material/LanguageOutlined';
import { gymPageCtaClicked, type GymPageCta } from '@boardsesh/analytics';
import LocaleLink from '@/app/components/i18n/locale-link';
import { trackGymFunnelEvent } from '@/app/lib/gym-funnel-analytics';

/** The two gym-page CTAs that are links rather than dialog triggers. */
type LinkCta = Extract<GymPageCta, 'kiosk' | 'website'>;

type GymPageCtaLinkProps = {
  cta: LinkCta;
  gymUuid: string;
  href: string;
  /**
   * Already translated by the server component that renders this island. The
   * label is passed in rather than looked up here so the island adds no i18n
   * key and no client-side translation load to a page that is mostly static.
   */
  label: string;
};

/**
 * Client island around the gym page's kiosk and website links.
 *
 * The `href` stays a real `href` on a real anchor — the click handler only
 * adds the event and never calls `preventDefault`, so crawlers, JS-off readers
 * and middle-clicks behave exactly as they did when these were plain
 * server-rendered anchors. Neither destination unloads the document (the kiosk
 * link is an in-app route, the website link opens in a new tab), so a plain
 * `track()` is enough — no flush-before-navigation dance.
 */
export default function GymPageCtaLink({ cta, gymUuid, href, label }: GymPageCtaLinkProps) {
  const handleClick = () => {
    trackGymFunnelEvent(gymPageCtaClicked({ cta, gymUuid }));
  };

  if (cta === 'kiosk') {
    return (
      <Button
        component={LocaleLink}
        href={href}
        onClick={handleClick}
        variant="contained"
        startIcon={<TvOutlined />}
        sx={{ textTransform: 'none' }}
      >
        {label}
      </Button>
    );
  }

  return (
    <MuiLink
      href={href}
      onClick={handleClick}
      target="_blank"
      rel="noopener noreferrer"
      underline="hover"
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: 'var(--color-primary)' }}
    >
      <LanguageOutlined sx={{ fontSize: 18 }} />
      {label}
    </MuiLink>
  );
}
