'use client';

import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import { track } from '@/app/lib/analytics';

/** The public card only hydrates its click event, never a complete beta row. */
export function PublicBetaLink({
  href,
  climbUuid,
  foreignUsername,
  platform,
  className,
  children,
}: {
  href: string;
  climbUuid?: string;
  foreignUsername?: string | null;
  platform: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <Box
      component="a"
      href={href}
      target="_blank"
      rel="ugc nofollow noopener noreferrer"
      className={className}
      onClick={() =>
        track('Beta Video Link Clicked', {
          platform,
          climbUuid,
          source: 'drawer',
          ...(foreignUsername ? { foreignUsername } : {}),
        })
      }
    >
      {children}
    </Box>
  );
}

/** Hide an unavailable thumbnail over the card's existing play-tile fallback. */
export function PublicBetaThumbnail({ src, className }: { src: string; className: string }) {
  return (
    <Box
      component="img"
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className={className}
      ref={(image: HTMLImageElement | null) => {
        if (image?.complete && image.naturalWidth === 0) image.hidden = true;
      }}
      onError={(event) => {
        event.currentTarget.hidden = true;
      }}
    />
  );
}
