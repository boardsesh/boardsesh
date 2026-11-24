import React from 'react';
import styles from './app-guide.module.css';

/**
 * "Want your board here?" art: a drawn board nobody has made yet. A tilted
 * board with its bolt-hole grid, a scatter of cartoon holds (a few lit in the
 * board's own start, hand, foot and finish colours) and a big "?" over it.
 * Decorative, so hidden from assistive tech; the card's heading says it all.
 *
 * Hold positions and shapes come from a fixed-seed generator at module load,
 * so the server and the browser draw the same board on every render.
 */

const VIEW_WIDTH = 480;
const VIEW_HEIGHT = 240;
const BOARD = { x: 92, y: 24, width: 296, height: 192, radius: 16 };
const CENTER = { x: VIEW_WIDTH / 2, y: VIEW_HEIGHT / 2 };
const HOLE_SPACING = 18;
const HOLD_COUNT = 15;

type HoldKind = 'jug' | 'crimp' | 'sloper';
type LitRole = 'start' | 'hand' | 'foot' | 'finish';
type Hold = { path: string; lit: LitRole | null };

/** mulberry32: a tiny deterministic PRNG. Never Math.random at render. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const SHAPES: Record<HoldKind, { radius: [number, number]; stretchX: number; stretchY: number; jitter: number }> = {
  jug: { radius: [11, 14], stretchX: 1.1, stretchY: 0.95, jitter: 0.28 },
  crimp: { radius: [12, 15], stretchX: 1.25, stretchY: 0.42, jitter: 0.18 },
  sloper: { radius: [15, 19], stretchX: 1.05, stretchY: 0.72, jitter: 0.12 },
};

const round = (value: number) => Math.round(value * 10) / 10;

/** A smooth closed blob: points on a jittered ellipse joined through their midpoints. */
function blobPath(random: () => number, x: number, y: number, kind: HoldKind): string {
  const shape = SHAPES[kind];
  const radius = shape.radius[0] + random() * (shape.radius[1] - shape.radius[0]);
  const turn = random() * Math.PI;
  const pointCount = 7;
  const points = Array.from({ length: pointCount }, (_, index) => {
    const angle = (index / pointCount) * Math.PI * 2;
    const reach = radius * (1 - shape.jitter / 2 + random() * shape.jitter);
    const localX = Math.cos(angle) * reach * shape.stretchX;
    const localY = Math.sin(angle) * reach * shape.stretchY;
    return {
      x: x + localX * Math.cos(turn) - localY * Math.sin(turn),
      y: y + localX * Math.sin(turn) + localY * Math.cos(turn),
    };
  });
  const midpoint = (from: { x: number; y: number }, to: { x: number; y: number }) => ({
    x: round((from.x + to.x) / 2),
    y: round((from.y + to.y) / 2),
  });
  const start = midpoint(points[pointCount - 1], points[0]);
  const curves = points.map((point, index) => {
    const end = midpoint(point, points[(index + 1) % pointCount]);
    return `Q${round(point.x)} ${round(point.y)} ${end.x} ${end.y}`;
  });
  return `M${start.x} ${start.y}${curves.join('')}Z`;
}

const LIT_ORDER: readonly LitRole[] = ['start', 'hand', 'foot', 'hand', 'finish'];
const KINDS: readonly HoldKind[] = ['jug', 'crimp', 'sloper'];

function buildHolds(): Hold[] {
  const random = seededRandom(8098);
  const placed: { x: number; y: number }[] = [];
  const holds: Hold[] = [];
  for (let attempt = 0; holds.length < HOLD_COUNT && attempt < 2000; attempt += 1) {
    const x = BOARD.x + 24 + random() * (BOARD.width - 48);
    const y = BOARD.y + 22 + random() * (BOARD.height - 44);
    // Keep the middle clear for the "?", and the holds apart from each other.
    if (Math.abs(x - CENTER.x) < 58 && Math.abs(y - CENTER.y) < 62) continue;
    if (placed.some((point) => Math.hypot(point.x - x, point.y - y) < 34)) continue;
    placed.push({ x, y });
    const kind = KINDS[holds.length % KINDS.length];
    const lit = holds.length % 3 === 0 ? (LIT_ORDER[holds.length / 3] ?? null) : null;
    holds.push({ path: blobPath(random, x, y, kind), lit });
  }
  return holds;
}

function buildHoles(): { x: number; y: number }[] {
  const holes: { x: number; y: number }[] = [];
  for (let y = BOARD.y + 14; y < BOARD.y + BOARD.height - 8; y += HOLE_SPACING) {
    for (let x = BOARD.x + 14; x < BOARD.x + BOARD.width - 8; x += HOLE_SPACING) holes.push({ x, y });
  }
  return holes;
}

const HOLDS = buildHolds();
const HOLES = buildHoles();

const LIT_CLASS: Record<LitRole, string> = {
  start: styles.mysteryLitStart,
  hand: styles.mysteryLitHand,
  foot: styles.mysteryLitFoot,
  finish: styles.mysteryLitFinish,
};

export default function MysteryBoardArt() {
  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
      className={styles.mysteryArt}
    >
      <g transform={`rotate(-4 ${CENTER.x} ${CENTER.y})`}>
        <rect
          x={BOARD.x}
          y={BOARD.y}
          width={BOARD.width}
          height={BOARD.height}
          rx={BOARD.radius}
          className={styles.mysteryBoard}
        />
        {HOLES.map((hole) => (
          <circle key={`${hole.x}-${hole.y}`} cx={hole.x} cy={hole.y} r={1.6} className={styles.mysteryHole} />
        ))}
        {HOLDS.map((hold) => (
          <path
            key={hold.path}
            d={hold.path}
            className={hold.lit ? `${styles.mysteryHold} ${LIT_CLASS[hold.lit]}` : styles.mysteryHold}
          />
        ))}
      </g>
      <text x={CENTER.x} y={CENTER.y} textAnchor="middle" dominantBaseline="central" className={styles.mysteryMark}>
        ?
      </text>
    </svg>
  );
}
