import React from 'react';
import type { HoldRenderData, LitUpHoldsMap } from './types';

type BoardLitupHoldsProps = {
  holdsData: HoldRenderData[];
  litUpHoldsMap: LitUpHoldsMap;
  mirrored: boolean;
  thumbnail?: boolean;
  onHoldClick?: (holdId: number, anchor: Element) => void;
};

const areLitUpHoldsMapsEqual = (prev: LitUpHoldsMap, next: LitUpHoldsMap): boolean => {
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);

  if (prevKeys.length !== nextKeys.length) return false;

  for (const key of prevKeys) {
    const numKey = Number(key);
    const prevHold = prev[numKey];
    const nextHold = next[numKey];
    if (!nextHold) return false;
    if (prevHold.state !== nextHold.state || prevHold.color !== nextHold.color) {
      return false;
    }
  }

  return true;
};

const BoardLitupHolds = React.memo(
  ({ holdsData, litUpHoldsMap, mirrored, thumbnail, onHoldClick }: BoardLitupHoldsProps) => {
    if (!holdsData) return null;

    // Skip transparent circles when they serve no purpose:
    // - Thumbnail mode: only render lit-up holds (typically 5-15 vs hundreds)
    // - No click handler: transparent circles are invisible and non-interactive
    const skipTransparent = thumbnail || !onHoldClick;
    const holdsToRender = skipTransparent
      ? holdsData.filter((hold) => {
          const entry = litUpHoldsMap[hold.id];
          return entry?.state && entry.state !== 'OFF';
        })
      : holdsData;

    return (
      <>
        {holdsToRender.map((hold) => {
          const isLitUp = litUpHoldsMap[hold.id]?.state && litUpHoldsMap[hold.id].state !== 'OFF';
          // Prefer the calibrated on-screen displayColor over the raw LED
          // color — the LED color is only correct for driving physical
          // board hardware over BLE (issue #2202).
          const color = isLitUp ? litUpHoldsMap[hold.id].displayColor || litUpHoldsMap[hold.id].color : 'transparent';

          let renderHold = hold;
          if (mirrored && hold.mirroredHoldId) {
            const mirroredHold = holdsData.find(({ id }) => id === hold.mirroredHoldId);
            if (!mirroredHold) {
              throw new Error("Couldn't find mirrored hold");
            }
            renderHold = mirroredHold;
          }

          return (
            <circle
              key={renderHold.id}
              id={`hold-${renderHold.id}`}
              data-mirror-id={renderHold.mirroredHoldId || undefined}
              cx={renderHold.cx}
              cy={renderHold.cy}
              r={renderHold.r}
              stroke={color}
              strokeWidth={thumbnail ? 8 : 6}
              fillOpacity={thumbnail ? 0.3 : 0}
              fill={thumbnail ? color : undefined}
              style={{ cursor: onHoldClick ? 'pointer' : 'default' }}
              onClick={onHoldClick ? (event) => onHoldClick(renderHold.id, event.currentTarget) : undefined}
            />
          );
        })}
      </>
    );
  },
  (prevProps, nextProps) => {
    return (
      prevProps.holdsData === nextProps.holdsData &&
      prevProps.mirrored === nextProps.mirrored &&
      prevProps.thumbnail === nextProps.thumbnail &&
      prevProps.onHoldClick === nextProps.onHoldClick &&
      areLitUpHoldsMapsEqual(prevProps.litUpHoldsMap, nextProps.litUpHoldsMap)
    );
  },
);

BoardLitupHolds.displayName = 'BoardLitupHolds';

export default BoardLitupHolds;
