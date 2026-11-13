import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import styles from './help-band.module.css';

export type HelpBandProps = {
  /** Anchor target. Guide ids are linked from the app and from docs; never rename one. */
  id?: string;
  /** Small violet line above the heading. */
  eyebrow?: string;
  /** Band heading. Omit on a `continues` band that carries on the one above it. */
  title?: string;
  /** 2 by default; 3 for a heading that belongs to the band above. */
  headingLevel?: 2 | 3;
  /** One sentence under the heading, in the larger lead type. */
  lead?: string;
  /** A phone capture, clip or photo. Without it the band is one text column. */
  media?: React.ReactNode;
  /** Media on the left, copy on the right. Alternate it band to band. */
  flip?: boolean;
  /**
   * The media is a second look at something the copy already says, so a phone
   * skips it below 900px and the page stays short. Copy is never hidden.
   */
  secondaryMedia?: boolean;
  /** Carries on the band above: no rule between them and less air on top. */
  continues?: boolean;
  /** Lets the body run the full 1136px (tile grids, state rows) instead of the reading measure. */
  wide?: boolean;
  /** The body: prose, steps, lists, buttons. */
  children?: React.ReactNode;
};

/**
 * One section of a help guide as a full-width band on the reading surface.
 *
 * With media, a desktop puts the heading and body in one column and the media
 * in the other (swap with `flip`); a phone stacks heading, media, body, so the
 * picture sits right under the question it answers. Without media the band is
 * a single column at the reading measure.
 *
 * Server-safe: no hooks, strings arrive resolved.
 */
export default function HelpBand({
  id,
  eyebrow,
  title,
  headingLevel = 2,
  lead,
  media,
  flip = false,
  secondaryMedia = false,
  continues = false,
  wide = false,
  children,
}: HelpBandProps) {
  const bandClass = [styles.band, continues ? styles.continues : null].filter(Boolean).join(' ');
  const innerClass = [
    styles.inner,
    media ? styles.withMedia : wide ? styles.wide : styles.solo,
    media && flip ? styles.flip : null,
    media && secondaryMedia ? styles.secondary : null,
  ]
    .filter(Boolean)
    .join(' ');
  const hasHead = Boolean(eyebrow || title || lead);

  return (
    <Box component="section" id={id} className={bandClass}>
      <Box className={innerClass}>
        {hasHead ? (
          <Box className={styles.head}>
            {eyebrow ? (
              <Typography component="p" className={styles.eyebrow}>
                {eyebrow}
              </Typography>
            ) : null}
            {title ? (
              <Typography
                variant={headingLevel === 2 ? 'h3' : 'h4'}
                component={headingLevel === 2 ? 'h2' : 'h3'}
                className={styles.title}
              >
                {title}
              </Typography>
            ) : null}
            {lead ? (
              <Typography variant="body1" component="p" className={styles.lead}>
                {lead}
              </Typography>
            ) : null}
          </Box>
        ) : null}
        {children ? <Box className={styles.body}>{children}</Box> : null}
        {media ? <Box className={styles.media}>{media}</Box> : null}
      </Box>
    </Box>
  );
}
