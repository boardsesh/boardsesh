import React from 'react';
import styles from './home-build-plans-card.module.css';

/**
 * The drawing on the homepage's build-plans card: a 7×10 Kilter Homewall laid
 * out the way a check sheet shows it. Units are inches, Aurora's own unit.
 *
 * The holes are the real layout, not a pattern that looks like one. Layout 8,
 * size 17 (7×10) spans x −44…44 and y 24…144; inside those edges set 26
 * (mainline) is an 8" grid of 11×15 and set 27 (auxiliary) is the same grid
 * shifted 4" both ways, 10×14. `__tests__/build-plans-drawing.test.tsx` checks
 * both against `@boardsesh/board-constants`, so a catalogue change shows up as a
 * red test rather than a drawing that quietly stops being true.
 *
 * The panel split is illustrative: 2440×1220 mm stock (96×48") cut into three
 * panels with every seam between hole rows. The generator chooses the real
 * split per order; the caption under the drawing says "split into panels" and
 * does not claim a count.
 *
 * The only text inside the SVG is the two dimension figures, 7′ and 10′: the
 * product's own size name, the same in every locale. The translated caption
 * names the image for assistive tech through `aria-labelledby`.
 */

export const HOMEWALL_EDGES = { left: -44, right: 44, bottom: 24, top: 144 } as const;

/** Width and height of the 7×10 wall in feet, as the dimension lines print them. */
export const DIMENSION_FIGURES = { width: '7′', height: '10′' } as const;

const GRID_PITCH = 8;

function gridPoints(firstX: number, lastX: number, firstY: number, lastY: number) {
  const points: Array<{ x: number; y: number }> = [];
  for (let y = firstY; y <= lastY; y += GRID_PITCH) {
    for (let x = firstX; x <= lastX; x += GRID_PITCH) points.push({ x, y });
  }
  return points;
}

export const MAINLINE_HOLES = gridPoints(-40, 40, 28, 140);
export const AUXILIARY_HOLES = gridPoints(-36, 36, 32, 136);

/** Panel bottoms and tops in wall inches, top panel first. Seams sit between hole rows. */
const PANELS = [
  { bottom: 98, top: HOMEWALL_EDGES.top },
  { bottom: 50, top: 98 },
  { bottom: HOMEWALL_EDGES.bottom, top: 50 },
] as const;

/** The panel drawn in full contrast: "one DXF per panel" made visible. */
const HIGHLIGHTED_PANEL = 1;

// Drawn larger than a real bore so they read at card size. The row either side
// of a seam is 2" away, so radius plus half-gap stays well under 2" and every
// hole clears its panel's edge.
const MAINLINE_RADIUS = 0.75;
const AUXILIARY_RADIUS = 0.5;

/** Half the gap drawn between neighbouring panels, so each reads as its own part. */
const SEAM_HALF_GAP = 0.6;

// Wall inches to SVG units: same scale, y flipped so the top of the wall is up.
const SVG_TOP = 150;
const toSvgY = (wallY: number) => SVG_TOP - wallY;

const WALL_LEFT = HOMEWALL_EDGES.left;
const WALL_RIGHT = HOMEWALL_EDGES.right;
const WALL_TOP_SVG = toSvgY(HOMEWALL_EDGES.top);
const WALL_BOTTOM_SVG = toSvgY(HOMEWALL_EDGES.bottom);

// Dimension lines sit outside the wall, as on a drawing, each broken in the
// middle for its figure.
const HEIGHT_DIM_X = WALL_LEFT - 8;
const WIDTH_DIM_Y = WALL_BOTTOM_SVG + 8;
const TICK = 1.8;
/** Half the break left in a dimension line for its figure (sized in the CSS module). */
const FIGURE_HALF_GAP = 5;

// Content runs from the "10′" figure (x ≈ −56, about 7.5 units wide centred on
// the height line at −52) to the wall's right edge (44), and from the top tick
// (y ≈ 4) to the width figure (y ≈ 136.5); about 2–4 units of margin all round.
const VIEW_BOX = { minX: -58, minY: 2, width: 106, height: 136 } as const;

const HEIGHT_MID = (WALL_TOP_SVG + WALL_BOTTOM_SVG) / 2;
const WIDTH_MID = (WALL_LEFT + WALL_RIGHT) / 2;

function Tick({ x, y }: { x: number; y: number }) {
  // The architect's slash at each end of a dimension line.
  return <line className={styles.drawingDimension} x1={x - TICK} y1={y + TICK} x2={x + TICK} y2={y - TICK} />;
}

export default function BuildPlansDrawing({ labelledBy }: { labelledBy: string }) {
  return (
    <svg
      className={styles.drawing}
      viewBox={`${VIEW_BOX.minX} ${VIEW_BOX.minY} ${VIEW_BOX.width} ${VIEW_BOX.height}`}
      role="img"
      aria-labelledby={labelledBy}
      focusable="false"
      data-testid="build-plans-drawing"
    >
      {PANELS.map((panel, index) => {
        const isHighlighted = index === HIGHLIGHTED_PANEL;
        const topGap = panel.top === HOMEWALL_EDGES.top ? 0 : SEAM_HALF_GAP;
        const bottomGap = panel.bottom === HOMEWALL_EDGES.bottom ? 0 : SEAM_HALF_GAP;
        const top = toSvgY(panel.top) + topGap;
        const bottom = toSvgY(panel.bottom) - bottomGap;
        const inPanel = (hole: { y: number }) => hole.y > panel.bottom && hole.y < panel.top;
        return (
          <g
            key={panel.top}
            className={isHighlighted ? styles.drawingPanelHighlighted : styles.drawingPanel}
            data-panel={index}
          >
            <rect
              className={styles.drawingPanelOutline}
              x={WALL_LEFT}
              y={top}
              width={WALL_RIGHT - WALL_LEFT}
              height={bottom - top}
            />
            {MAINLINE_HOLES.filter(inPanel).map((hole) => (
              <circle
                key={`m${hole.x}:${hole.y}`}
                className={styles.drawingHole}
                cx={hole.x}
                cy={toSvgY(hole.y)}
                r={MAINLINE_RADIUS}
              />
            ))}
            {AUXILIARY_HOLES.filter(inPanel).map((hole) => (
              <circle
                key={`a${hole.x}:${hole.y}`}
                className={styles.drawingHoleAux}
                cx={hole.x}
                cy={toSvgY(hole.y)}
                r={AUXILIARY_RADIUS}
              />
            ))}
          </g>
        );
      })}

      {/* Height: extension lines off the wall's top and bottom, then the dimension. */}
      <g>
        <line
          className={styles.drawingExtension}
          x1={WALL_LEFT - 2}
          y1={WALL_TOP_SVG}
          x2={HEIGHT_DIM_X - 2}
          y2={WALL_TOP_SVG}
        />
        <line
          className={styles.drawingExtension}
          x1={WALL_LEFT - 2}
          y1={WALL_BOTTOM_SVG}
          x2={HEIGHT_DIM_X - 2}
          y2={WALL_BOTTOM_SVG}
        />
        <line
          className={styles.drawingDimension}
          x1={HEIGHT_DIM_X}
          y1={WALL_TOP_SVG}
          x2={HEIGHT_DIM_X}
          y2={HEIGHT_MID - FIGURE_HALF_GAP}
        />
        <line
          className={styles.drawingDimension}
          x1={HEIGHT_DIM_X}
          y1={HEIGHT_MID + FIGURE_HALF_GAP}
          x2={HEIGHT_DIM_X}
          y2={WALL_BOTTOM_SVG}
        />
        <Tick x={HEIGHT_DIM_X} y={WALL_TOP_SVG} />
        <Tick x={HEIGHT_DIM_X} y={WALL_BOTTOM_SVG} />
        <text
          className={styles.drawingFigure}
          x={HEIGHT_DIM_X}
          y={HEIGHT_MID}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {DIMENSION_FIGURES.height}
        </text>
      </g>

      {/* Width, under the wall. */}
      <g>
        <line
          className={styles.drawingExtension}
          x1={WALL_LEFT}
          y1={WALL_BOTTOM_SVG + 2}
          x2={WALL_LEFT}
          y2={WIDTH_DIM_Y + 2}
        />
        <line
          className={styles.drawingExtension}
          x1={WALL_RIGHT}
          y1={WALL_BOTTOM_SVG + 2}
          x2={WALL_RIGHT}
          y2={WIDTH_DIM_Y + 2}
        />
        <line
          className={styles.drawingDimension}
          x1={WALL_LEFT}
          y1={WIDTH_DIM_Y}
          x2={WIDTH_MID - FIGURE_HALF_GAP}
          y2={WIDTH_DIM_Y}
        />
        <line
          className={styles.drawingDimension}
          x1={WIDTH_MID + FIGURE_HALF_GAP}
          y1={WIDTH_DIM_Y}
          x2={WALL_RIGHT}
          y2={WIDTH_DIM_Y}
        />
        <Tick x={WALL_LEFT} y={WIDTH_DIM_Y} />
        <Tick x={WALL_RIGHT} y={WIDTH_DIM_Y} />
        <text
          className={styles.drawingFigure}
          x={WIDTH_MID}
          y={WIDTH_DIM_Y}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {DIMENSION_FIGURES.width}
        </text>
      </g>
    </svg>
  );
}
