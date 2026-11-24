import React from 'react';
import Box from '@mui/material/Box';
import type { TileArt } from '@/app/lib/seo/app-guides';
import type { T } from './guide-parts';
import HoldRing, { type HoldRole } from './hold-ring';
import styles from './app-guide.module.css';

/**
 * Simple drawn diagrams for the tiles with no real capture yet (the browser app,
 * Android, tablets). Decorative and `aria-hidden`: the tile's own heading and
 * sentence carry the meaning. They are drawn, never dressed up as screenshots.
 */

// A 9 x 5 hole grid with a plausible climb lit on it: start low, hands up, finish top.
const MINI_BOARD: (HoldRole | null)[] = [
  [null, null, 'finish', null, null, null, null, null, null],
  [null, null, null, null, 'hand', null, null, null, null],
  [null, 'hand', null, null, null, null, null, 'foot', null],
  [null, null, null, null, null, 'hand', null, null, null],
  [null, null, null, 'start', null, null, 'start', null, null],
].flat() as (HoldRole | null)[];

function MiniBoard() {
  return (
    <Box className={styles.miniBoard}>
      {MINI_BOARD.map((role, index) =>
        role ? (
          <HoldRing key={index} role={role} className={styles.miniLit} />
        ) : (
          <Box key={index} component="span" className={styles.miniHole} />
        ),
      )}
    </Box>
  );
}

export function BrowserDiagram({ t }: { t: T }) {
  return (
    <Box className={styles.browser}>
      <Box className={styles.browserBar}>
        <Box component="span" className={styles.browserDot} />
        <Box component="span" className={styles.browserDot} />
        <Box component="span" className={styles.browserDot} />
        <Box component="span" className={styles.browserUrl}>
          {t('appGuides:common.diagrams.url')}
        </Box>
      </Box>
      <MiniBoard />
    </Box>
  );
}

type Outline = { id: string; shape?: 'phone' | 'laptop' | 'tablet' };

const OUTLINES: Record<'android' | 'devices' | 'tablet', readonly Outline[]> = {
  android: [{ id: 'anyAndroid' }, { id: 'anyMaker' }],
  devices: [{ id: 'iphone' }, { id: 'android' }, { id: 'browser', shape: 'laptop' }],
  tablet: [
    { id: 'ipad', shape: 'tablet' },
    { id: 'androidTablet', shape: 'tablet' },
  ],
};

function OutlinesDiagram({ t, set }: { t: T; set: keyof typeof OUTLINES }) {
  return (
    <Box className={styles.phonesDiagram}>
      {OUTLINES[set].map(({ id, shape = 'phone' }) => (
        <figure key={id}>
          <Box
            className={[
              styles.outline,
              shape === 'laptop' ? styles.outlineLaptop : null,
              shape === 'tablet' ? styles.outlineTablet : null,
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <HoldRing role="start" size="md" />
          </Box>
          {t(`appGuides:common.diagrams.${id}`)}
        </figure>
      ))}
    </Box>
  );
}

export function TileDiagram({ t, art }: { t: T; art: Extract<TileArt, { kind: 'diagram' }> }) {
  return (
    <Box className={styles.diagram} aria-hidden="true">
      {art.diagram === 'browser' ? <BrowserDiagram t={t} /> : null}
      {art.diagram === 'board' ? (
        <Box className={styles.browser}>
          <MiniBoard />
        </Box>
      ) : null}
      {art.diagram === 'android' || art.diagram === 'devices' || art.diagram === 'tablet' ? (
        <OutlinesDiagram t={t} set={art.diagram} />
      ) : null}
    </Box>
  );
}
