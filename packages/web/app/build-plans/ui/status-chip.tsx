import React from 'react';
import Box from '@mui/material/Box';
import type { CncOrderStatus } from '@boardsesh/shared-schema';
import styles from './build-plans-ui.module.css';

/**
 * One order's state, in one pill.
 *
 * Every status a build-plans order can be in, including the four free-preview
 * ones the preview flow adds. `BuildPlanStatus` is a superset of the schema's
 * `CncOrderStatus` on purpose: the preview values land in the SDL in a later
 * change, and this component must already draw them without the schema type
 * moving underneath it. When they do land, `CncOrderStatus` stays assignable
 * and nothing here changes.
 *
 * The chip is not MUI's `Chip`: filled MUI chips at eleven different colours
 * read as a traffic accident on a list page. These are tinted, low-chroma
 * pills with a dot, and the tone carries the verdict:
 *
 * - `neutral` — nothing is happening and nothing is wrong (waiting on you, lapsed).
 * - `progress` — the generator has it; come back in a minute.
 * - `brand`  — a free preview is ready. Violet, because the next move is yours.
 * - `success` — the paid pack is downloadable.
 * - `warning` — the download is off but nothing broke (refunded).
 * - `error`  — it did not build.
 *
 * Text is a prop, not a lookup, so the chip renders in a server component
 * (`getServerTranslation`) and a client one (`useTranslation`) alike.
 */
export type BuildPlanStatus =
  | CncOrderStatus
  | 'preview_queued'
  | 'preview_generating'
  | 'preview_ready'
  | 'preview_failed';

type Tone = 'neutral' | 'progress' | 'brand' | 'success' | 'warning' | 'error';

const TONE_BY_STATUS: Record<BuildPlanStatus, Tone> = {
  preview_queued: 'progress',
  preview_generating: 'progress',
  preview_ready: 'brand',
  preview_failed: 'error',
  pending_payment: 'neutral',
  queued: 'progress',
  generating: 'progress',
  ready: 'success',
  failed: 'error',
  cancelled: 'neutral',
  refunded: 'warning',
};

const TONE_CLASS: Record<Tone, string> = {
  neutral: styles.toneNeutral,
  progress: styles.toneProgress,
  brand: styles.toneBrand,
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  error: styles.toneError,
};

export type StatusChipProps = {
  status: BuildPlanStatus;
  /** The translated label — `t(`status.${status}`)` from the `cnc` catalog. */
  label: React.ReactNode;
};

export default function StatusChip({ status, label }: StatusChipProps) {
  return (
    <Box component="span" className={`${styles.status} ${TONE_CLASS[TONE_BY_STATUS[status]]}`}>
      <Box component="span" aria-hidden className={styles.statusDot} />
      {label}
    </Box>
  );
}

/** Exported for tests and for anything that needs the verdict without the pill. */
export function buildPlanStatusTone(status: BuildPlanStatus): Tone {
  return TONE_BY_STATUS[status];
}
