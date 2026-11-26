'use client';

import React, { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { Locale } from '@/app/lib/i18n/config';
import { sectionHeadingTypeClassName } from '@/app/components/ui/page-shell/page-section';

// Keep the query, board configuration and video cards out of the first paint.
const HomeRecentBetaContent = dynamic(() => import('./home-recent-beta-content'), { ssr: false });

/** Cached homepage HTML contains only this section's public copy, never beta rows. */
export default function HomeRecentBetaSection({
  locale,
  resources,
  title,
  lead,
}: {
  locale: Locale;
  resources: Record<string, Record<string, unknown>>;
  title: string;
  lead: string;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          setNearViewport(true);
        }
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <Box
      component="section"
      ref={sectionRef}
      aria-labelledby="home-recent-beta-heading"
      sx={{ display: 'flex', flexDirection: 'column', gap: 3, width: '100%' }}
    >
      <Typography variant="h3" component="h2" id="home-recent-beta-heading" className={sectionHeadingTypeClassName}>
        {title}
      </Typography>
      <Typography component="p" variant="body1" color="text.secondary">
        {lead}
      </Typography>
      {/* The rail is about 270px tall. Reserve it through loading/empty/error states. */}
      <Box sx={{ minHeight: 'calc(var(--spacing-16) * 4 + var(--spacing-4))' }}>
        {nearViewport ? <HomeRecentBetaContent locale={locale} resources={resources} /> : null}
      </Box>
    </Box>
  );
}
