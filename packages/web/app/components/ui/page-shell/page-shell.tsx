import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import styles from './page-shell.module.css';

export type PageShellWidth = 'prose' | 'wide';

export type PageShellProps = {
  /** The page's one <h1>. Always renders as an h1 — `titleVariant` only scales it. */
  title: string;
  /** One sentence under the title. */
  lead?: string;
  /** Small uppercase kicker above the title (a section name, a board type). */
  eyebrow?: React.ReactNode;
  /** Breadcrumb trail, rendered above the header. Give it real <a> elements. */
  breadcrumb?: React.ReactNode;
  /** `prose` (≈68ch) for long-form copy; `wide` (1200px) for grids and maps. */
  width?: PageShellWidth;
  /** Visual scale of the title only. The element stays an <h1> either way. */
  titleVariant?: 'h1' | 'h2';
  headerAlign?: 'start' | 'center';
  headerClassName?: string;
  headerActions?: React.ReactNode;
  children: React.ReactNode;
};

/**
 * The frame every long-form page sits in.
 *
 * Deliberately SERVER-SAFE — no `'use client'`, no hooks. `/privacy` and the gym
 * directory are React Server Components, and a client shell would drag them over
 * the boundary. Strings arrive as props already resolved by the caller's `t()`,
 * which also keeps `vp run check:i18n` happy: the literals stay in the page files.
 *
 * It owns the clearance for the fixed MarketingHeader. Pages must NOT add their
 * own in-page header bar — the global one is the header, and a second bar stacked
 * under it is the thing this replaced.
 */
export default function PageShell({
  title,
  lead,
  eyebrow,
  breadcrumb,
  width = 'prose',
  titleVariant = 'h1',
  headerAlign = 'start',
  headerClassName: customHeaderClassName,
  headerActions,
  children,
}: PageShellProps) {
  const innerClassName = `${styles.inner} ${width === 'wide' ? styles.wide : styles.prose}`;
  const headerClassName = headerAlign === 'center' ? `${styles.header} ${styles.headerCenter}` : styles.header;

  return (
    <Box component="main" className={styles.pageShell}>
      <Box className={innerClassName}>
        <Box component="header" className={`${headerClassName} ${customHeaderClassName ?? ''}`}>
          {breadcrumb ? <Box className={styles.breadcrumb}>{breadcrumb}</Box> : null}
          {eyebrow ? <Box className={styles.eyebrow}>{eyebrow}</Box> : null}
          <Typography
            variant={titleVariant === 'h1' ? 'h2' : 'h3'}
            component="h1"
            className={`${styles.title} ${titleVariant === 'h2' ? styles.titleCompact : ''}`}
          >
            {title}
          </Typography>
          {lead ? (
            <Typography variant="body1" component="p" className={styles.lead}>
              {lead}
            </Typography>
          ) : null}
          {headerActions}
        </Box>
        {children}
      </Box>
    </Box>
  );
}
