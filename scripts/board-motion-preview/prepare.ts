/**
 * Board motion lab previews, step 1: drive each variant's real driver through
 * one scripted swipe at 120 Hz, pick ten frames, and have the production Rust
 * packet encoder write the packet and those frames' uniforms. `render.mjs`
 * then draws them with the real Metal shader. See README.md.
 *
 *   vp exec node --import tsx scripts/board-motion-preview/prepare.ts \
 *     --out ~/.cache/claude-tmp/board-motion-lab/preview-work \
 *     --packet-cli <target>/release/examples/prepare_gpu_packet
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalogueGpuConfig } from '../gpu-atlas-census';
import { getBoardDetailsForBoard } from '../../packages/shared/board-render/src/board-details';
import { listCatalogueEntries } from '../../packages/shared/board-render/src/render-version-projection';
import { SWIPE_THRESHOLD } from '../../packages/shared/play-view/src/swipe-carousel';
import { BOARD_MOTION_VARIANTS } from '../../packages/mobile/src/components/board-motion-lab/variants';
import type { BoardMotionVariant, ParamValues } from '../../packages/mobile/src/components/board-motion-lab/types';
import { encodeSwapLook, type BoardSwapFrame } from '../../packages/mobile/src/components/play-drawer/swap-look';
import type { BoardTransitionState } from '../../packages/mobile/src/components/play-drawer/board-transition';
import type { WallSwapInput } from '../../packages/mobile/src/components/play-drawer/wall-swap';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../..');

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return resolve(value.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
}

const output = option('--out');
const packetCli = option('--packet-cli');
/** A, then the swap-look variants: the shipped swap next to every new look. */
const VARIANT_IDS = ['shipped-wall-swap', 'sideways-cascade', 'ghost-peek', 'climb-up', 'led-strike', 'focus-in'];

/** Kilter Homewall 8/25 at native 1080 × 1504, the Aura transition golden's board. */
const CATALOGUE = { boardName: 'kilter', layoutId: 8, sizeId: 25, setIds: [26, 27, 28, 29] };

/** Real recorded Kilter Homewall climbs (12-14 holds), so a front has something to sweep across. */
function recordedClimbs(): { current: string; next: string; previous: string; names: string[] } {
  const path = join(repository, 'packages/mobile/src/components/board-motion-lab/recorded-climbs.json');
  const recorded = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { name: string; frames: string }[]>;
  const [current, next, previous] = recorded['kilter-8'];
  return { current: current.frames, next: next.frames, previous: previous.frames, names: [current.name, next.name] };
}

/**
 * The swipe: a finger drags left to the commit distance over 400 ms and lets
 * go; the fling lands 150 ms later. Frames are captured at these clock times.
 */
const DRAG_MS = 400;
const LAND_MS = DRAG_MS + 150;
const END_MS = DRAG_MS + 700;
const CAPTURES: readonly { atMs: number; label: string }[] = [
  { atMs: 100, label: 'drag 20 pt' },
  { atMs: 200, label: 'drag 40 pt' },
  { atMs: 300, label: 'drag 60 pt' },
  { atMs: DRAG_MS, label: 'commit at 80 pt' },
  { atMs: DRAG_MS + 40, label: '+40 ms' },
  { atMs: DRAG_MS + 80, label: '+80 ms' },
  { atMs: DRAG_MS + 120, label: '+120 ms' },
  { atMs: DRAG_MS + 170, label: '+170 ms' },
  { atMs: DRAG_MS + 230, label: '+230 ms' },
  { atMs: END_MS, label: 'rest' },
];

function defaults(variant: BoardMotionVariant): ParamValues {
  return Object.fromEntries(variant.params.map((spec) => [spec.key, spec.default]));
}

/** Steps the driver every 1/120 s as use-wall-swap would, with the pager the swipe above makes. */
function simulate(variant: BoardMotionVariant) {
  const transition = variant.createTransition(defaults(variant));
  if (!transition.driver) throw new Error(`${variant.id} has no driver`);
  const driver = transition.driver;
  const frameMs = 1000 / 120;
  let input: WallSwapInput = {
    anchor: 0,
    offset: 0,
    fling: 0,
    steps: 0,
    reset: 0,
    swapMs: 0,
    settleMs: 0,
    reduceMotion: false,
    commitDistance: SWIPE_THRESHOLD,
  };
  let state: BoardTransitionState = driver.rest(input);
  let swapStarted: { atMs: number; lengthMs: number } | null = null;
  let settleStarted: { atMs: number; lengthMs: number } | null = null;
  const captured: { atMs: number; label: string; frame: BoardSwapFrame }[] = [];
  let next = 0;
  for (let tick = 0; next < CAPTURES.length; tick++) {
    const atMs = tick * frameMs;
    const committed = input.steps > 0;
    let offset = input.offset;
    let { anchor, fling, steps } = input;
    if (atMs <= DRAG_MS) offset = -SWIPE_THRESHOLD * (atMs / DRAG_MS);
    if (atMs >= DRAG_MS && !committed) {
      steps += 1;
      fling = 1;
    }
    if (atMs >= LAND_MS && fling !== 0) {
      anchor += fling;
      fling = 0;
      offset = 0;
    }
    input = {
      ...input,
      anchor,
      fling,
      steps,
      offset,
      swapMs: swapStarted ? Math.min(atMs - swapStarted.atMs, swapStarted.lengthMs) : input.swapMs,
      settleMs: settleStarted ? Math.min(atMs - settleStarted.atMs, settleStarted.lengthMs) : input.settleMs,
    };
    const step = driver.step(state, input);
    state = step.state;
    if (step.startSwapMs !== null) swapStarted = { atMs, lengthMs: step.startSwapMs };
    if (step.startSettleMs !== null) settleStarted = { atMs, lengthMs: step.startSettleMs };
    if (atMs >= CAPTURES[next].atMs - 1e-6) {
      captured.push({ ...CAPTURES[next], frame: step.frame });
      next += 1;
    }
  }
  return { transition, captured };
}

/**
 * One frame as the native view selects it (`ClimbOverlayMotion.selectSwap`
 * with the packet centred on page 0): the scene slots (0 current, 1 previous,
 * 2 next), the lower/upper weights and arrival flags. A frame at rest is a
 * single climb, which the view draws with the still compositor.
 */
function select(frame: BoardSwapFrame) {
  const position = Math.max(-1, Math.min(1, frame[0]));
  const flags = frame.length === 6 ? [frame[4] >= 0.5, frame[5] >= 0.5] : [false, false];
  if (Number.isInteger(position)) {
    const slot = position === 0 ? 0 : position < 0 ? 1 : 2;
    return { lower: slot, upper: slot, swap: [1, 0, 1], arrivals: [false, false] };
  }
  const [lower, upper, progress] = position < 0 ? [1, 0, 1 + position] : [0, 2, position];
  const outgoingIsLower = progress < 0.5;
  const swap = outgoingIsLower ? [frame[1], frame[2], frame[3]] : [frame[2], frame[1], frame[3]];
  const arrivals = outgoingIsLower ? flags : [flags[1], flags[0]];
  return { lower, upper, swap, arrivals };
}

function run(executable: string, args: string[]) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) throw new Error(`${executable} failed: ${result.stderr || result.stdout}`);
  return result;
}

if (existsSync(output)) throw new Error(`Output exists, pick a fresh directory: ${output}`);
mkdirSync(join(output, 'packet'), { recursive: true });

const entry = listCatalogueEntries().find(
  (candidate) =>
    candidate.boardName === CATALOGUE.boardName &&
    candidate.layoutId === CATALOGUE.layoutId &&
    candidate.sizeId === CATALOGUE.sizeId &&
    JSON.stringify(candidate.setIds) === JSON.stringify(CATALOGUE.setIds),
);
if (!entry) throw new Error('Kilter Homewall 8/25 is no longer in the catalogue');
const config = { ...buildCatalogueGpuConfig(entry), frames: '', mirrored: false, glyphs: 'role' };
const climbs = recordedClimbs();
const source = { current: climbs.current, previous: climbs.previous, next: climbs.next, strict: false };

const samples: Record<string, unknown>[] = [];
const controls: Record<string, unknown>[] = [];
const variants: Record<string, unknown>[] = [];
for (const id of VARIANT_IDS) {
  const variant = BOARD_MOTION_VARIANTS.find((candidate) => candidate.id === id);
  if (!variant) throw new Error(`No variant ${id}`);
  const { transition, captured } = simulate(variant);
  variants.push({ id, letter: variant.letter, name: variant.name, params: defaults(variant) });
  captured.forEach(({ label, frame, atMs }, index) => {
    const name = `${variant.letter.toLowerCase()}-${index}`;
    const selected = select(frame);
    controls.push({
      name,
      lower: selected.lower,
      upper: selected.upper,
      progress: 0,
      pulse: 1,
      mirrored: false,
      swap: selected.swap,
    });
    samples.push({
      name,
      variant: id,
      letter: variant.letter,
      label,
      atMs,
      frame,
      ...selected,
      look: transition.look ? encodeSwapLook(transition.look) : null,
    });
  });
}
if (controls.length > 64) throw new Error('The packet CLI takes at most 64 samples');

writeFileSync(join(output, 'config.json'), JSON.stringify(config));
writeFileSync(join(output, 'source-request.json'), JSON.stringify(source));
writeFileSync(join(output, 'controls.json'), JSON.stringify({ version: 1, samples: controls }, null, 2));
run(packetCli, [
  join(output, 'config.json'),
  join(output, 'source-request.json'),
  join(output, 'packet'),
  join(output, 'controls.json'),
]);
const packet = JSON.parse(readFileSync(join(output, 'packet/packet.json'), 'utf8')) as {
  width: number;
  height: number;
  scenes: { offset: number; bytes: number; count: number }[];
};

// The board photo the overlay sits on in the app: the layout's image layers, in order.
const details = getBoardDetailsForBoard({
  board_name: entry.boardName,
  layout_id: entry.layoutId,
  size_id: entry.sizeId,
  set_ids: entry.setIds,
});
const layers = Object.keys(details.images_to_holds).map((image) =>
  join(repository, 'packages/web/public/images', entry.boardName, image),
);
run('magick', [
  '-size',
  `${packet.width}x${packet.height}`,
  'xc:black',
  ...layers.flatMap((layer) => [layer, '-resize', `${packet.width}x${packet.height}!`, '-composite']),
  join(output, 'board.png'),
]);

writeFileSync(
  join(output, 'timeline.json'),
  JSON.stringify(
    {
      width: packet.width,
      height: packet.height,
      scenes: packet.scenes.map(({ offset, bytes, count }) => ({ offset, bytes, count })),
      climbs: climbs.names,
      variants,
      samples,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ output, samples: samples.length, climbs: climbs.names, scenes: packet.scenes }));
