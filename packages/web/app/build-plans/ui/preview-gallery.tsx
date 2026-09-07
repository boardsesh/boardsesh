import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import styles from './build-plans-ui.module.css';

/**
 * The free preview: the watermarked sheets, as a grid you can actually read.
 *
 * The watermark is the point of this screen, so nothing here dims, crops or
 * overlays the images — every tile is `object-fit: contain` on a light plate,
 * at 4:3, so a panel drawing and the assembly sheet sit at the same size and
 * "PREVIEW · NOT FOR MANUFACTURE" stays legible in the thumbnail. Do not add a
 * hover zoom or a lightbox that hides it.
 *
 * The plate is `--neutral-50` rather than the card surface because the sheets
 * are black-on-white drawings: on a dark scheme they need something to sit on
 * that is not the page.
 *
 * `note` carries the one line of context ("Free preview. Finalise to get the
 * DXF."); `actions` carries the download and the finalise button.
 */
export type PreviewImage = {
  /** The preview key's basename, e.g. `panel1.png`. Also the React key. */
  name: string;
  /** Backend URL carrying a one-hour grant token. */
  url: string;
  /** Human label under the tile, and the image's alt text. */
  label: string;
};

export type PreviewGalleryProps = {
  images: readonly PreviewImage[];
  /** One line above the grid saying what these are and what they are not. */
  note?: React.ReactNode;
  /** Download / finalise, under the grid. */
  actions?: React.ReactNode;
  /** Names the grid for screen readers, e.g. "Preview sheets". */
  'aria-label'?: string;
};

export default function PreviewGallery({ images, note, actions, 'aria-label': ariaLabel }: PreviewGalleryProps) {
  return (
    <Box>
      {note ? (
        <Typography variant="body2" component="p" className={styles.galleryNote}>
          {note}
        </Typography>
      ) : null}
      <Box className={styles.gallery} aria-label={ariaLabel}>
        {images.map((image) => (
          <Box component="figure" key={image.name} className={styles.galleryTile}>
            <Box className={styles.galleryFrame}>
              {/* A plain <img>, not next/image: these are short-lived, token-signed
                  backend URLs, so there is nothing for the image optimiser to
                  cache and a signed URL in the optimiser's cache key is a leak. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={styles.galleryImage} src={image.url} alt={image.label} loading="lazy" />
            </Box>
            <Typography variant="caption" component="figcaption" className={styles.galleryCaption}>
              {image.label}
            </Typography>
          </Box>
        ))}
      </Box>
      {actions ? <Box className={styles.headerActions}>{actions}</Box> : null}
    </Box>
  );
}
