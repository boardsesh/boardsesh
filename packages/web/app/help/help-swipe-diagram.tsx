import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import ArrowForwardOutlined from '@mui/icons-material/ArrowForwardOutlined';
import styles from './help-swipe-diagram.module.css';

/** Every visible string, already resolved by the caller's `t()`. */
export type HelpSwipeDiagramLabels = {
  /** Whole-figure accessible name: says in prose what the drawing shows. */
  description: string;
  /** Caption over the list row. */
  listCaption: string;
  /** The climb opened from a list, e.g. "Search results · 4 of 23". */
  listCurrent: string;
  /** Its neighbour one swipe back. */
  listPrevious: string;
  /** Its neighbour one swipe on. */
  listNext: string;
  /** Caption over the wall row. */
  wallCaption: string;
  /** The preview state, e.g. "Preview · not on the wall". */
  preview: string;
  /** The action that lights a preview, e.g. "Put on board". */
  putOnBoard: string;
  /** The lit climb. */
  onWall: string;
  /** The queue section, e.g. "Up next". */
  upNext: string;
  /** The source list section, e.g. "Then from Search results". */
  thenFrom: string;
  /** The card after the last climb. */
  endCard: string;
};

export type HelpSwipeDiagramProps = {
  labels: HelpSwipeDiagramLabels;
};

type NodeVariant = 'plain' | 'current' | 'live' | 'preview' | 'end';

function Node({ variant, children, className }: { variant: NodeVariant; children: string; className?: string }) {
  const classes = [styles.node, styles[variant], className].filter(Boolean).join(' ');
  return (
    <Box component="span" className={classes}>
      {variant === 'live' ? <Box component="span" className={styles.liveDot} /> : null}
      {children}
    </Box>
  );
}

function Arrow({ direction, className }: { direction: 'back' | 'forward'; className?: string }) {
  const classes = [styles.arrow, direction === 'back' ? styles.arrowBack : styles.arrowForward, className]
    .filter(Boolean)
    .join(' ');
  return <ArrowForwardOutlined className={classes} />;
}

/**
 * Where a swipe goes in the player, drawn as two rows of pills and arrows.
 *
 * Row 1: a climb opened from a list, with its neighbours either side. Row 2: a
 * preview that "Put on board" lights, then the chain a swipe follows from the
 * lit climb: Up next, the list it came from, the end card.
 *
 * The figure is `role="img"` with `labels.description` as its name, so the
 * pills and arrows are one picture to a screen reader rather than a dozen
 * fragments. Rows run left to right from 640px and stack top to bottom below
 * it (arrows turn to point down). Server-safe: no hooks, strings arrive resolved.
 *
 * @example
 * <HelpSwipeDiagram labels={swipeDiagramLabels} />
 */
export default function HelpSwipeDiagram({ labels }: HelpSwipeDiagramProps) {
  return (
    <Box component="figure" role="img" aria-label={labels.description} className={styles.figure}>
      <Box className={styles.row}>
        <Typography component="p" className={styles.caption}>
          {labels.listCaption}
        </Typography>
        <Box className={styles.listFlow}>
          <Node variant="plain">{labels.listPrevious}</Node>
          <Arrow direction="back" />
          <Node variant="current">{labels.listCurrent}</Node>
          <Arrow direction="forward" />
          <Node variant="plain">{labels.listNext}</Node>
        </Box>
      </Box>

      <Box className={styles.row}>
        <Typography component="p" className={styles.caption}>
          {labels.wallCaption}
        </Typography>
        <Box className={styles.wallFlow}>
          <Node variant="preview" className={styles.branchStart}>
            {labels.preview}
          </Node>
          <Box component="span" className={styles.branchLink}>
            <ArrowForwardOutlined className={[styles.arrow, styles.arrowDown].join(' ')} />
            <Box component="span" className={styles.branchLabel}>
              {labels.putOnBoard}
            </Box>
          </Box>
          <Node variant="live" className={styles.chainItem}>
            {labels.onWall}
          </Node>
          <Arrow direction="forward" className={styles.chainItem} />
          <Node variant="plain" className={styles.chainItem}>
            {labels.upNext}
          </Node>
          <Arrow direction="forward" className={styles.chainItem} />
          <Node variant="plain" className={styles.chainItem}>
            {labels.thenFrom}
          </Node>
          <Arrow direction="forward" className={styles.chainItem} />
          <Node variant="end" className={styles.chainItem}>
            {labels.endCard}
          </Node>
        </Box>
      </Box>
    </Box>
  );
}
