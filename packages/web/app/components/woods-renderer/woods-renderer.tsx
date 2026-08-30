'use client';

import React, { useMemo } from 'react';
import type { HoldRenderData, LitUpHoldsMap } from '../board-renderer/types';
import { getImageUrl, toDarkArtUrl } from '../board-renderer/util';
import styles from '../board-renderer/board-art-theme.module.css';

// Props for the Woods renderer. Like the MoonBoard renderer it draws the board
// art plus a circle per lit hold, but it consumes the precomputed `holdsData`
// (built by `getWoodsBoardDetails`) rather than recomputing a regular grid —
// the Woods board has variable-width rows with detected (non-grid) centres.
export type WoodsBoardRendererProps = {
  holdsData: HoldRenderData[];
  // Background-art filename under public/images/woods/ (e.g. 'woods-8x10-bg.png').
  backgroundImage: string;
  boardWidth: number;
  boardHeight: number;
  litUpHoldsMap?: LitUpHoldsMap;
  mirrored?: boolean;
  thumbnail?: boolean;
  fillHeight?: boolean;
  onHoldClick?: (holdId: number, anchor: Element) => void;
};

const TRANSPARENT = 'transparent';

const WoodsBoardRenderer: React.FC<WoodsBoardRendererProps> = ({
  holdsData,
  backgroundImage,
  boardWidth,
  boardHeight,
  litUpHoldsMap = {},
  mirrored = false,
  thumbnail = false,
  fillHeight = false,
  onHoldClick,
}) => {
  // Woods art ships the same three variants every other board does — full-size
  // .png, .webp, and a 416px thumbs/*.webp — so build the href the shared way:
  // getImageUrl rewrites .png → .webp and splices /thumbs/ for thumbnails. Woods is
  // also the only board on web with a dark sibling; see woods-renderer.module.css for
  // why both are rendered and CSS chooses.
  const backgroundHref = getImageUrl(backgroundImage, 'woods', thumbnail);
  const darkBackgroundHref = toDarkArtUrl(backgroundHref);

  // Index holds by id for O(1) mirror lookups. Woods holds are distinctly shaped
  // and asymmetric, so a mirrored climb keeps the board art fixed and re-positions
  // each lit hold onto its horizontal mirror (mirroredHoldId) — unlike the
  // MoonBoard renderer, which flips the whole SVG.
  const holdsById = useMemo(() => {
    const map = new Map<number, HoldRenderData>();
    for (const hold of holdsData) map.set(hold.id, hold);
    return map;
  }, [holdsData]);

  // A hold's colour comes from the lit-up map, which is already populated from
  // HOLD_STATE_MAP.woods (role codes 1/2/3/4) when the frames string is parsed.
  const getHoldColor = (holdId: number): string => {
    const hold = litUpHoldsMap[holdId];
    if (!hold) return TRANSPARENT;
    return hold.displayColor || hold.color || TRANSPARENT;
  };

  // Memoize SVG style object to prevent recreation on every render. fillHeight:
  // SVG fills container height; preserveAspectRatio="xMidYMid meet" letterboxes
  // the image so the full board is always visible regardless of container aspect.
  const svgStyle = useMemo(
    () =>
      fillHeight
        ? { width: '100%', height: '100%', display: 'block' as const }
        : {
            width: '100%',
            height: 'auto',
            display: 'block' as const,
            maxHeight: thumbnail ? '10vh' : '55vh',
          },
    [thumbnail, fillHeight],
  );

  return (
    <svg viewBox={`0 0 ${boardWidth} ${boardHeight}`} preserveAspectRatio="xMidYMid meet" style={svgStyle}>
      {/* Board background art, light and dark. The Fetch Priority API does not apply to
          inline SVG images; LCP-critical cards should be preloaded via `<link rel="preload">`
          from the page-level server component (which still preloads the light file). */}
      <image href={backgroundHref} width="100%" height="100%" className={styles.lightArt} />
      <image href={darkBackgroundHref} width="100%" height="100%" className={styles.darkArt} />

      {/* Render hold circles - skip transparent ones when they serve no purpose */}
      {holdsData.map((hold) => {
        const color = getHoldColor(hold.id);
        const isLitUp = color !== TRANSPARENT;

        // Skip transparent circles in thumbnail mode or when there's no click handler
        if (!isLitUp && (thumbnail || !onHoldClick)) return null;

        // When mirrored, draw this hold's state on its horizontal mirror position.
        const renderHold = (mirrored && hold.mirroredHoldId != null && holdsById.get(hold.mirroredHoldId)) || hold;

        return (
          <circle
            key={hold.id}
            id={`hold-${renderHold.id}`}
            cx={renderHold.cx}
            cy={renderHold.cy}
            r={renderHold.r}
            stroke={color}
            strokeWidth={thumbnail ? 8 : 6}
            fillOpacity={thumbnail && isLitUp ? 1 : 0}
            fill={thumbnail && isLitUp ? color : 'transparent'}
            style={{ cursor: onHoldClick ? 'pointer' : 'default' }}
            onClick={onHoldClick ? (event) => onHoldClick(renderHold.id, event.currentTarget) : undefined}
          />
        );
      })}
    </svg>
  );
};

export default WoodsBoardRenderer;
