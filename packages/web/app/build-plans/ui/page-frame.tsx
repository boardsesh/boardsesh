import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import styles from './build-plans-ui.module.css';

/**
 * The frame every `/build-plans*` page sits in: one `<main>`, one measure, one
 * `<h1>`, and one owner for the vertical rhythm between sections.
 *
 * It exists because the four pages of this surface had four different ideas
 * about width and top padding, and because MUI's `h1` variant is unpinned in
 * our theme — a bare `variant="h1"` renders at ~110px, which is what made this
 * surface read as a template. The title size lives in the CSS module and is the
 * same on every page here.
 *
 * Server component: no state, no handlers. Both the shop landing (client
 * configurator inside) and the licence page mount it.
 */
export type PageFrameProps = {
  /** The page's one `<h1>`. */
  title: React.ReactNode;
  /** One paragraph under the title. Anything longer belongs in a section. */
  intro?: React.ReactNode;
  /** A back link or breadcrumb row, above the title. */
  eyebrow?: React.ReactNode;
  /** Buttons and links under the intro. The first one is the page's primary action. */
  actions?: React.ReactNode;
  /** A quiet line under the actions — availability notes, trademark footnotes. */
  note?: React.ReactNode;
  /**
   * `wide` (1120px) for pages with a two-column workbench; `prose` (760px) for
   * pages that are read top to bottom.
   */
  width?: 'wide' | 'prose';
  /**
   * Draws the header on the dot-grid plate — the hold grid the product is about.
   * The shop landing only; a second plate on the same surface would make it
   * decoration rather than the one loud thing.
   */
  plate?: boolean;
  /** Sections. Spacing between them is the frame's job, not theirs. */
  children: React.ReactNode;
};

export default function PageFrame({
  title,
  intro,
  eyebrow,
  actions,
  note,
  width = 'wide',
  plate = false,
  children,
}: PageFrameProps) {
  const header = (
    <>
      {eyebrow ? <Box className={styles.eyebrow}>{eyebrow}</Box> : null}
      <Typography variant="h1" className={styles.pageTitle}>
        {title}
      </Typography>
      {intro ? (
        <Typography variant="body1" component="p" className={styles.pageIntro}>
          {intro}
        </Typography>
      ) : null}
      {actions ? <Box className={styles.headerActions}>{actions}</Box> : null}
      {note ? (
        <Typography variant="body2" component="p" className={styles.headerNote}>
          {note}
        </Typography>
      ) : null}
    </>
  );

  return (
    <Box component="main" className={`${styles.page} ${width === 'wide' ? styles.widthWide : styles.widthProse}`}>
      <Box component="header" className={`${styles.header} ${plate ? styles.plate : ''}`}>
        {header}
      </Box>
      <Box className={styles.stack}>{children}</Box>
    </Box>
  );
}
