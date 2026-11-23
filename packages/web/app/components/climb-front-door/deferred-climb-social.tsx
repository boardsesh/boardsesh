'use client';

import React, { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import ChatBubbleOutlineRounded from '@mui/icons-material/ChatBubbleOutlineRounded';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useOptionalBrowserSession } from '@/app/components/providers/session-provider';
import { themeTokens } from '@/app/theme/theme-config';

// Its own chunk, loaded on demand: nothing below it (comments, grade votes,
// proposals) is fetched, or even downloaded, until it mounts.
const ClimbSocialSection = dynamic(() => import('@/app/components/social/climb-social-section'), { ssr: false });

/** How far ahead of the viewport a signed-in reader's comments start loading. */
export const SOCIAL_PRELOAD_MARGIN = '600px';

const HEADING_ID = 'climb-social-heading';

type DeferredClimbSocialProps = {
  climbUuid: string;
  boardType: string;
  angle: number;
  currentClimbDifficulty?: string;
  boardName: string;
  /** Already translated on the server, so this island needs no client catalog of its own. */
  labels: {
    /** "Comments and grade votes" */
    heading: string;
    /** "Sign in to join in" */
    signIn: string;
    /** "Show comments" */
    show: string;
  };
};

const sectionSx = { mt: 3 };

const rowSx = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  columnGap: `${themeTokens.spacing[3]}px`,
  rowGap: `${themeTokens.spacing[1]}px`,
  padding: { xs: `${themeTokens.spacing[3]}px ${themeTokens.spacing[4]}px`, md: `14px ${themeTokens.spacing[5]}px` },
  backgroundColor: 'var(--semantic-surface)',
  border: '1px solid var(--separator)',
  borderRadius: `${themeTokens.borderRadius.lg + 2}px`,
};

const iconSx = { flex: 'none', width: 22, height: 22, color: 'var(--neutral-500)' };

// A heading for the outline (the comment list below it has its own `<h3>`),
// set as the row's text rather than as another band title.
const headingSx = {
  flex: '1 1 auto',
  margin: 0,
  color: 'var(--neutral-800)',
  fontFamily: 'inherit',
  fontSize: themeTokens.typography.fontSize.base,
  fontWeight: themeTokens.typography.fontWeight.medium,
  letterSpacing: 0,
};

const controlsSx = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: `${themeTokens.spacing[2]}px` };

const signInSx = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 44,
  paddingInline: `${themeTokens.spacing[1]}px`,
  fontWeight: themeTokens.typography.fontWeight.semibold,
};

const showSx = {
  minHeight: 44,
  textTransform: 'none',
  fontWeight: themeTokens.typography.fontWeight.semibold,
  fontSize: themeTokens.typography.fontSize.base,
  color: 'var(--color-primary)',
};

const contentSx = { mt: 2, '&:focus': { outline: 'none' } };

/**
 * Comments and grade votes, without paying for them up front.
 *
 * The section's queries (comments, votes, proposals) used to run on every
 * page view, Googlebot's included, for a section at the very end of the page
 * that most readers never reach. Now:
 *
 *  - Signed out (and in the shared server HTML, which is the same for
 *    everyone): one row, "Comments and grade votes", a "Sign in to join in"
 *    link and a "Show comments" button. Nothing is fetched or downloaded until
 *    the button is tapped.
 *  - Signed in: the section mounts by itself once the row comes within 600px
 *    of the screen, so it is there by the time the reader scrolls to it. The
 *    button stays for a reader who gets there first.
 *
 * Both controls are at least 44px tall.
 */
export default function DeferredClimbSocial({
  climbUuid,
  boardType,
  angle,
  currentClimbDifficulty,
  boardName,
  labels,
}: DeferredClimbSocialProps) {
  // A missing provider reads as signed out, matching the shared server HTML.
  const signedIn = useOptionalBrowserSession()?.status === 'authenticated';
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const openedByTap = useRef(false);

  useEffect(() => {
    if (!signedIn || open) return;
    const row = rowRef.current;
    if (!row) return;
    if (typeof IntersectionObserver === 'undefined') {
      setOpen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          setOpen(true);
        }
      },
      { rootMargin: `${SOCIAL_PRELOAD_MARGIN} 0px` },
    );
    observer.observe(row);
    return () => observer.disconnect();
  }, [signedIn, open]);

  // The button that had focus is gone once the section opens: hand focus to
  // what replaced it, so a keyboard reader carries on from there.
  useEffect(() => {
    if (open && openedByTap.current) contentRef.current?.focus();
  }, [open]);

  const signInHref = `/auth/login?callbackUrl=${encodeURIComponent(pathname ?? '/')}`;

  return (
    <Box component="section" aria-labelledby={HEADING_ID} sx={sectionSx}>
      <Box ref={rowRef} sx={rowSx} data-testid="climb-social-row">
        <ChatBubbleOutlineRounded aria-hidden sx={iconSx} />
        <Typography component="h2" id={HEADING_ID} sx={headingSx}>
          {labels.heading}
        </Typography>
        {open ? null : (
          <Box sx={controlsSx}>
            {signedIn ? null : (
              <MuiLink component={LocaleLink} href={signInHref} sx={signInSx}>
                {labels.signIn}
              </MuiLink>
            )}
            <Button
              variant="text"
              sx={showSx}
              onClick={() => {
                openedByTap.current = true;
                setOpen(true);
              }}
            >
              {labels.show}
            </Button>
          </Box>
        )}
      </Box>
      {open ? (
        <Box ref={contentRef} tabIndex={-1} sx={contentSx}>
          <ClimbSocialSection
            climbUuid={climbUuid}
            boardType={boardType}
            angle={angle}
            currentClimbDifficulty={currentClimbDifficulty}
            boardName={boardName}
          />
        </Box>
      ) : null}
    </Box>
  );
}
