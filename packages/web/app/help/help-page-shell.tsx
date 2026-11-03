import React from 'react';
import Box from '@mui/material/Box';
import type { SxProps, Theme } from '@mui/material/styles';
import { PageShell, type PageShellProps } from '@/app/components/ui/page-shell';
import shell from '@/app/components/ui/page-shell/page-shell.module.css';

/**
 * The help site's reading type, laid over the shared PageShell.
 *
 * /about, /legal and /privacy share PageShell's grey leads and 32px section
 * headings. Help pages are read differently: someone is mid-problem, scanning
 * for the one section that answers it. So, on /help only:
 *
 * - leads move from --neutral-500 (8.2:1) to --neutral-700 (13.0:1) and up a size,
 *   so the one-line summary under a heading is the easiest thing to read, not
 *   the hardest;
 * - body copy is pinned to --neutral-800 with a looser line height;
 * - section headings drop to 28px (24px on a phone) with more air above them, so
 *   a page of eight sections reads as a list of questions;
 * - a list followed by a paragraph gets the paragraph gap it was missing.
 *
 * The overrides target PageShell's own module classes from a wrapper, so the
 * shared component and every other page stay pixel-identical. Selectors carry
 * one extra class each to beat the shell's doubled `.x.x` heading rule.
 */
const helpTypeSx: SxProps<Theme> = {
  [`& .${shell.header} .${shell.lead}`]: {
    maxWidth: '62ch',
    color: 'var(--neutral-700)',
    fontSize: 'var(--font-size-lg)',
    lineHeight: 1.55,
  },
  [`& .${shell.section} .${shell.sectionLead}`]: {
    color: 'var(--neutral-700)',
    fontSize: 'var(--font-size-lg)',
    lineHeight: 1.55,
  },
  [`& .${shell.section} .${shell.paragraph}, & .${shell.section} .${shell.list}`]: {
    color: 'var(--neutral-800)',
    lineHeight: 1.7,
  },
  [`& .${shell.section} .${shell.list} li::marker`]: {
    color: 'var(--neutral-500)',
  },
  [`& .${shell.section} .${shell.paragraph} + .${shell.paragraph}, & .${shell.section} .${shell.list} + .${shell.paragraph}`]:
    {
      marginTop: 'var(--spacing-4)',
    },
  [`& .${shell.section} .${shell.sectionHeading}.${shell.sectionHeadingType}.${shell.sectionHeadingType}`]: {
    marginBottom: 'var(--spacing-3)',
    color: 'var(--neutral-900)',
    fontSize: '28px',
    fontWeight: 700,
    lineHeight: 1.25,
  },
  [`& .${shell.section} + .${shell.section}`]: {
    marginTop: 'var(--spacing-12)',
  },
  '@media (max-width: 760px)': {
    [`& .${shell.section} .${shell.sectionHeading}.${shell.sectionHeadingType}.${shell.sectionHeadingType}`]: {
      fontSize: 'var(--font-size-2xl)',
    },
    [`& .${shell.section} + .${shell.section}`]: {
      marginTop: 'var(--spacing-10)',
    },
  },
};

/** PageShell with the help site's reading type. Takes exactly PageShell's props. */
export default function HelpPageShell(props: PageShellProps) {
  return (
    <Box sx={helpTypeSx}>
      <PageShell {...props} />
    </Box>
  );
}
