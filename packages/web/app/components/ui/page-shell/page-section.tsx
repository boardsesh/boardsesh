import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import styles from './page-shell.module.css';

export type PageSectionTone = 'brand' | 'accent' | 'neutral';

export type PageSectionProps = {
  /** Section heading. Omit for an unheaded block that still gets the rhythm. */
  title?: string;
  /** 2 by default. Use 3 for a sub-section inside another PageSection. */
  headingLevel?: 2 | 3;
  /** An MUI icon element. Colour comes from `tone`, not from the caller. */
  icon?: React.ReactElement<{ className?: string }>;
  tone?: PageSectionTone;
  /** One sentence under the heading, before the body. */
  lead?: string;
  /** Anchor target — the module already carries the scroll-margin for the header. */
  id?: string;
  className?: string;
  children?: React.ReactNode;
};

const TONE_CLASS: Record<PageSectionTone, string> = {
  brand: styles.toneBrand,
  accent: styles.toneAccent,
  neutral: styles.toneNeutral,
};

/** A titled block inside a PageShell. Server-safe, like the shell. */
export default function PageSection({
  title,
  headingLevel = 2,
  icon,
  tone = 'brand',
  lead,
  id,
  className,
  children,
}: PageSectionProps) {
  return (
    <Box component="section" id={id} className={`${styles.section} ${className ?? ''}`}>
      {title ? (
        <Typography
          variant={headingLevel === 2 ? 'h3' : 'h4'}
          component={headingLevel === 2 ? 'h2' : 'h3'}
          className={styles.sectionHeading}
        >
          {icon
            ? React.cloneElement(icon, {
                className: [styles.sectionIcon, TONE_CLASS[tone], icon.props.className].filter(Boolean).join(' '),
              })
            : null}
          {title}
        </Typography>
      ) : null}
      {lead ? (
        <Typography variant="body1" component="p" className={styles.sectionLead}>
          {lead}
        </Typography>
      ) : null}
      {children}
    </Box>
  );
}
