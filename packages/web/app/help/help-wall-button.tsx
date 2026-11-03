import React from 'react';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { resolveStaticAssetUrl } from '@/app/lib/static-asset-url';
import { helpScreenshot, type HelpShot } from '@/app/lib/help-screenshots';
import styles from './help-wall-button.module.css';

/**
 * Where the wall button sits inside each full-phone capture, in capture pixels.
 *
 * The state rows show only the button, cut out of the real capture with CSS (an
 * aspect-ratio box with the whole capture positioned inside it), so there is no
 * second, edited image to keep in step with the app. The cost: a recapture that
 * moves the button moves the crop. After re-shooting `preview`, `drive-timed` or
 * `drive-open`, open /help/board-and-bluetooth#driving and check each row still
 * shows the whole capsule with a few pixels of black around it; if not, find
 * the capsule's top-left corner in the new capture and change that shot's
 * numbers here. The box is the capsule plus about 8px of margin.
 */
export const WALL_BUTTON_CROP_BOX = { width: 697, height: 92 } as const;

export type WallButtonShot = Extract<HelpShot, 'preview' | 'drive-timed' | 'drive-open'>;

/** Top-left corner of the crop box in each capture (preview is 736 x 1600, the two drive stills 737 x 1600; under 2 px apart, so one offset fits all three). */
export const WALL_BUTTON_CROP_OFFSETS: Record<WallButtonShot, { x: number; y: number }> = {
  // "Put on board": the violet capsule under the action row.
  preview: { x: 20, y: 1387 },
  // "You are driving the wall · 0:28": same capsule, frosted, with the clock.
  'drive-timed': { x: 20, y: 1387 },
  // "You are driving the wall": frosted, no clock.
  'drive-open': { x: 20, y: 1387 },
};

/**
 * The crop as percentages of the box, which is what CSS positions against:
 * width and left are relative to the box's width, top to its height.
 */
export function wallButtonCrop(shot: WallButtonShot) {
  const capture = helpScreenshot(shot);
  const { x, y } = WALL_BUTTON_CROP_OFFSETS[shot];
  const { width, height } = WALL_BUTTON_CROP_BOX;
  const percent = (ratio: number) => `${(ratio * 100).toFixed(3)}%`;
  return {
    width: percent(capture.width / width),
    left: percent(-x / width),
    top: percent(-y / height),
  };
}

export type WallButtonState = {
  shot: WallButtonShot;
  /** Small label beside the dot ("Looking", "Timed drive"). */
  label: string;
  title: string;
  body: string;
  alt: string;
  /** Amber dot for a driving state, grey for looking. */
  driving: boolean;
};

/** One row: what the button says on the left, the real button on the right. */
function WallButtonRow({ shot, label, title, body, alt, driving }: WallButtonState) {
  const capture = helpScreenshot(shot);
  const crop = wallButtonCrop(shot);
  return (
    <Box component="li" className={styles.row}>
      <Box className={styles.bar} sx={{ '--crop-width': crop.width, '--crop-left': crop.left, '--crop-top': crop.top }}>
        <Image
          src={resolveStaticAssetUrl(capture.src)}
          alt={alt}
          width={capture.width}
          height={capture.height}
          // The capture is drawn ~1.06x the bar's width; the bar tops out near 760px.
          sizes="(max-width: 900px) 100vw, 820px"
          className={styles.capture}
        />
      </Box>
      <Box className={styles.text}>
        <Typography component="p" className={styles.label}>
          <Box component="span" aria-hidden="true" className={`${styles.dot} ${driving ? styles.dotLive : ''}`} />
          {label}
        </Typography>
        <Typography component="h3" className={styles.title}>
          {title}
        </Typography>
        <Typography component="p" className={styles.body}>
          {body}
        </Typography>
      </Box>
    </Box>
  );
}

/**
 * The wall button's three states, each shown as the button itself, cropped
 * from the real capture, beside a one-line reading of it.
 */
export default function HelpWallButtonStates({ states }: { states: readonly WallButtonState[] }) {
  return (
    <Box component="ul" className={styles.rows}>
      {states.map((state) => (
        <WallButtonRow key={state.shot} {...state} />
      ))}
    </Box>
  );
}
