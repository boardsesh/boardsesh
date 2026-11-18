/**
 * Board motion lab previews, step 1: drive each variant's real driver, pick the
 * frames to draw, and have the production Rust packet encoder write every packet
 * those frames need, with a few base uniform samples per packet (the renderer
 * patches each frame's weights into them) and Rust-encoded samples to check that
 * patching byte for byte. `render.mjs` draws them with the real Metal shader.
 * See README.md.
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
import { buildSyntheticClimbs, LAB_BOARDS } from '../../packages/mobile/src/components/board-motion-lab/fixtures';
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

/** A first, then the swap looks in the lab's order (I and J first). */
const VARIANT_IDS = [
  'shipped-wall-swap',
  ...BOARD_MOTION_VARIANTS.filter((variant) => variant.requiresNativeLab === 'swap-look').map((variant) => variant.id),
];

type Board = { key: string; catalogue: { boardName: string; layoutId: number; sizeId: number; setIds: number[] } };
const KILTER: Board = {
  key: 'kilter',
  catalogue: { boardName: 'kilter', layoutId: 8, sizeId: 25, setIds: [26, 27, 28, 29] },
};
const MOONBOARD: Board = {
  key: 'moonboard',
  catalogue: { boardName: 'moonboard', layoutId: 3, sizeId: 1, setIds: [5, 6, 7, 8, 9, 10] },
};

function recorded(key: string): string[] {
  const path = join(repository, 'packages/mobile/src/lib/board-render/fixtures/recorded-climbs.json');
  const climbs = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { name: string; frames: string }[]>;
  return climbs[key].map((climb) => climb.frames);
}

function defaults(variant: BoardMotionVariant): ParamValues {
  return Object.fromEntries(variant.params.map((spec) => [spec.key, spec.default]));
}

function variantById(id: string): BoardMotionVariant {
  const variant = BOARD_MOTION_VARIANTS.find((candidate) => candidate.id === id);
  if (!variant) throw new Error(`No variant ${id}`);
  return variant;
}

// --- Swipes -----------------------------------------------------------------

/** The pager's offset over time (board points, left negative); a repeated time is a jump. */
type Keyframe = readonly [atMs: number, offset: number];
type Script = {
  keyframes: readonly Keyframe[];
  commits: readonly number[];
  /** When the fling lands (or a finger catches it): the anchor moves on. */
  lands: readonly number[];
  endMs: number;
  phases: readonly (readonly [fromMs: number, label: string])[];
};

function offsetAt(keyframes: readonly Keyframe[], atMs: number): number {
  let value = keyframes[0][1];
  for (let index = 0; index < keyframes.length; index++) {
    const [time, offset] = keyframes[index];
    if (time > atMs) {
      const [previousTime, previousOffset] = keyframes[index - 1] ?? [time, offset];
      return previousTime === time
        ? offset
        : previousOffset + ((offset - previousOffset) * (atMs - previousTime)) / (time - previousTime);
    }
    value = offset;
  }
  return value;
}

/** The ten-frame swipe of the contact sheets: a drag to the commit distance over 400 ms, then let go. */
const SHEET_SCRIPT: Script = {
  keyframes: [
    [0, 0],
    [400, -SWIPE_THRESHOLD],
    [550, -SWIPE_THRESHOLD],
    [550, 0],
    [1200, 0],
  ],
  commits: [400],
  lands: [550],
  endMs: 1100,
  phases: [],
};
const SHEET_CAPTURES: readonly (readonly [atMs: number, label: string])[] = [
  [100, 'drag 20 pt'],
  [200, 'drag 40 pt'],
  [300, 'drag 60 pt'],
  [400, 'commit at 80 pt'],
  [440, '+40 ms'],
  [480, '+80 ms'],
  [520, '+120 ms'],
  [570, '+170 ms'],
  [630, '+230 ms'],
  [1100, 'rest'],
];

/**
 * The motion previews: a slow drag held at the commit distance and let go, a
 * quick flick, then a flick re-flicked 90 ms after it commits (the case where a
 * skipped climb's front could flip side). Pages run 0 → 4.
 */
const MOTION_SCRIPT: Script = {
  keyframes: [
    [0, 0],
    [500, -80],
    [850, -80],
    [850, 0],
    [1600, 0],
    [1670, -12],
    [1720, -75],
    [1840, -75],
    [1840, 0],
    [2500, 0],
    [2570, -12],
    [2620, -75],
    [2650, -75],
    [2650, -20],
    [2710, -70],
    [2830, -70],
    [2830, 0],
    [3400, 0],
  ],
  commits: [700, 1720, 2620, 2710],
  lands: [850, 1840, 2650, 2830],
  endMs: 3400,
  phases: [
    [0, 'slow drag'],
    [500, 'hold at 80 pt'],
    [700, 'release: swap'],
    [1300, 'rest'],
    [1600, 'quick flick'],
    [1720, 'swap'],
    [2300, 'rest'],
    [2500, 'flick'],
    [2620, 'flick again 90 ms later'],
    [2710, 'swap'],
    [3000, 'rest'],
  ],
};

function phaseAt(script: Script, atMs: number): string {
  let label = '';
  for (const [fromMs, phase] of script.phases) if (atMs >= fromMs) label = phase;
  return label;
}

/** Steps `variant` with `params` every `stepMs` through `script`, as use-wall-swap would; one frame per step. */
function simulate(
  variant: BoardMotionVariant,
  params: ParamValues,
  script: Script,
  stepMs: number,
  keepAtMs?: readonly number[],
) {
  const transition = variant.createTransition(params);
  if (!transition.driver) throw new Error(`${variant.id} has no driver`);
  const driver = transition.driver;
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
  let nextCommit = 0;
  let nextLand = 0;
  const frames: { atMs: number; frame: BoardSwapFrame }[] = [];
  let keep = 0;
  for (let tick = 0; ; tick++) {
    const atMs = tick * stepMs;
    if (atMs > script.endMs + 1e-6) break;
    let { anchor, fling, steps } = input;
    while (nextCommit < script.commits.length && atMs >= script.commits[nextCommit] - 1e-6) {
      steps += 1;
      fling = 1;
      nextCommit += 1;
    }
    while (nextLand < script.lands.length && atMs >= script.lands[nextLand] - 1e-6) {
      anchor += fling;
      fling = 0;
      nextLand += 1;
    }
    input = {
      ...input,
      anchor,
      fling,
      steps,
      offset: offsetAt(script.keyframes, atMs),
      swapMs: swapStarted ? Math.min(atMs - swapStarted.atMs, swapStarted.lengthMs) : input.swapMs,
      settleMs: settleStarted ? Math.min(atMs - settleStarted.atMs, settleStarted.lengthMs) : input.settleMs,
    };
    const step = driver.step(state, input);
    state = step.state;
    if (step.startSwapMs !== null) swapStarted = { atMs, lengthMs: step.startSwapMs };
    if (step.startSettleMs !== null) settleStarted = { atMs, lengthMs: step.startSettleMs };
    if (!keepAtMs) frames.push({ atMs, frame: step.frame });
    else if (keep < keepAtMs.length && atMs >= keepAtMs[keep] - 1e-6) {
      frames.push({ atMs, frame: step.frame });
      keep += 1;
    }
  }
  return { look: transition.look ? encodeSwapLook(transition.look) : null, frames };
}

// --- Packets ------------------------------------------------------------------

type PacketPlan = {
  key: string;
  board: string;
  dir: string;
  climbs: [string, string, string];
  extra: Record<string, unknown>[];
};
const packets = new Map<string, PacketPlan>();

/** The packet centred on `current`, as the native view prepares the pager's trio. */
function packetFor(board: Board, previous: string, current: string, next: string): string {
  const key = `${board.key}|${previous}|${current}|${next}`;
  if (!packets.has(key)) {
    packets.set(key, {
      key,
      board: board.key,
      dir: `packet-${packets.size}`,
      climbs: [previous, current, next],
      extra: [],
    });
  }
  return packets.get(key)!.dir;
}

/**
 * One frame as the native view draws it (`ClimbOverlayMotion.selectSwap`, the
 * packet centred on the page being left): the packet, its scene slots (0
 * current, 1 previous, 2 next), the weights the uniforms carry (a look frame's
 * shared weight follows the shipped rule, S1), the look's shared floor, and each
 * side's arrival code. A frame on one climb is drawn by the still compositor.
 */
function select(board: Board, climbAt: (page: number) => string, frame: BoardSwapFrame) {
  const from = Math.round(frame[0]);
  const delta = Math.max(-1, Math.min(1, frame[0] - from));
  const packet = packetFor(board, climbAt(from - 1), climbAt(from), climbAt(from + 1));
  if (delta === 0) return { packet, lower: 0, upper: 0, swap: [1, 0, 1], sharedFloor: 1, codes: [0, 0] };
  const [lower, upper, progress] = delta < 0 ? [1, 0, 1 + delta] : [0, 2, delta];
  const look = frame.length === 6;
  const shared = look ? Math.min(1, Math.max(frame[3], frame[1], frame[2])) : frame[3];
  const codes = look ? [frame[4], frame[5]] : [0, 0];
  const outgoingIsLower = progress < 0.5;
  return {
    packet,
    lower,
    upper,
    swap: outgoingIsLower ? [frame[1], frame[2], shared] : [frame[2], frame[1], shared],
    sharedFloor: frame[3],
    codes: outgoingIsLower ? codes : [codes[1], codes[0]],
  };
}

// --- What to draw -------------------------------------------------------------

const kilterClimbs = recorded('kilter-8');
const cycle = (climbs: readonly string[]) => (page: number) =>
  climbs[((page % climbs.length) + climbs.length) % climbs.length];
/** Kilter pages 0, 1, 2 are the recorded climbs; the ring repeats, as the lab's does. */
const kilterAt = cycle(kilterClimbs);

type SheetFrame = ReturnType<typeof select> & { label: string; look: readonly number[] | null };
const sheets: { id: string; board: string; title: string; frames: SheetFrame[] }[] = [];

function addSheet(
  id: string,
  title: string,
  board: Board,
  variantId: string,
  params: ParamValues,
  climbAt: (page: number) => string,
) {
  const variant = variantById(variantId);
  const { look, frames } = simulate(
    variant,
    params,
    SHEET_SCRIPT,
    1000 / 120,
    SHEET_CAPTURES.map(([atMs]) => atMs),
  );
  sheets.push({
    id,
    board: board.key,
    title,
    frames: frames.map(({ frame }, index) => ({
      ...select(board, climbAt, frame),
      label: SHEET_CAPTURES[index][1],
      look,
    })),
  });
}

for (const id of VARIANT_IDS) {
  const variant = variantById(id);
  addSheet(
    `${variant.letter}-${variant.id}`,
    `${variant.letter} · ${variant.name} · Subtle`,
    KILTER,
    id,
    defaults(variant),
    kilterAt,
  );
  if (variant.boldParams) {
    addSheet(
      `${variant.letter}-${variant.id}-bold`,
      `${variant.letter} · ${variant.name} · Bold`,
      KILTER,
      id,
      variant.boldParams,
      kilterAt,
    );
  }
}

// I against A where the climbs share holds, and on a busy MoonBoard.
const homewall = LAB_BOARDS.find((board) => board.id === 'kilter-homewall-7x10');
if (!homewall) throw new Error('No Kilter Homewall 7x10 lab board');
const compareSets: { id: string; label: string; board: Board; climbs: readonly string[] }[] = [
  {
    id: 'mostly',
    label: '90% shared holds',
    board: KILTER,
    climbs: buildSyntheticClimbs(homewall, 'mostly').map((climb) => climb.frames),
  },
  {
    id: 'role-change',
    label: 'shared holds change role',
    board: KILTER,
    climbs: buildSyntheticClimbs(homewall, 'role-change').map((climb) => climb.frames),
  },
  { id: 'moonboard', label: 'MoonBoard 2024', board: MOONBOARD, climbs: recorded('moonboard-3') },
];
for (const set of compareSets) {
  for (const id of ['shipped-wall-swap', 'ghost-peek-standby', 'sideways-strike']) {
    const variant = variantById(id);
    addSheet(
      `${variant.letter}-${set.id}`,
      `${variant.letter} · ${variant.name} · ${set.label}`,
      set.board,
      id,
      defaults(variant),
      cycle(set.climbs),
    );
  }
}

// The motion previews: Subtle at 1× and 0.25×, Bold at 0.25×. 0.25× is true slow motion: every clock and the finger.
const motion: {
  id: string;
  variant: string;
  letter: string;
  name: string;
  preset: string;
  speed: string;
  look: readonly number[] | null;
  frames: (ReturnType<typeof select> & { atMs: number; phase: string })[];
}[] = [];
for (const [preset, speed, slow] of [
  ['subtle', '1x', 1],
  ['subtle', '0.25x', 4],
  ['bold', '0.25x', 4],
] as const) {
  for (const id of VARIANT_IDS) {
    const variant = variantById(id);
    const params =
      preset === 'bold'
        ? (variant.boldParams ?? (id === 'shipped-wall-swap' ? defaults(variant) : undefined))
        : defaults(variant);
    if (!params) continue;
    const { look, frames } = simulate(variant, params, MOTION_SCRIPT, 1000 / 60 / slow);
    motion.push({
      id: `${variant.letter}-${variant.id}${preset === 'bold' ? '-bold' : ''}-${speed}`,
      variant: id,
      letter: variant.letter,
      name: variant.name,
      preset,
      speed,
      look,
      frames: frames.map(({ atMs, frame }) => ({
        ...select(KILTER, kilterAt, frame),
        atMs,
        phase: phaseAt(MOTION_SCRIPT, atMs),
      })),
    });
  }
}

// --- Packets, boards, Rust ----------------------------------------------------

function run(executable: string, args: string[]) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) throw new Error(`${executable} failed: ${result.stderr || result.stdout}`);
  return result;
}

if (existsSync(output)) throw new Error(`Output exists, pick a fresh directory: ${output}`);
mkdirSync(output, { recursive: true });

const boards: Record<string, { width: number; height: number; photo: string }> = {};
for (const board of [KILTER, MOONBOARD]) {
  const entry = listCatalogueEntries().find(
    (candidate) =>
      candidate.boardName === board.catalogue.boardName &&
      candidate.layoutId === board.catalogue.layoutId &&
      candidate.sizeId === board.catalogue.sizeId &&
      JSON.stringify(candidate.setIds) === JSON.stringify(board.catalogue.setIds),
  );
  if (!entry) throw new Error(`${board.key} is no longer in the catalogue`);
  const directory = join(output, board.key);
  mkdirSync(directory);
  const config = { ...buildCatalogueGpuConfig(entry), frames: '', mirrored: false, glyphs: 'role' };
  writeFileSync(join(directory, 'config.json'), JSON.stringify(config));
  // The board photo the overlay sits on in the app: the layout's image layers, in order.
  const details = getBoardDetailsForBoard({
    board_name: entry.boardName,
    layout_id: entry.layoutId,
    size_id: entry.sizeId,
    set_ids: entry.setIds,
  });
  const width = Number(config.board_width);
  const height = Number(config.board_height);
  run('magick', [
    '-size',
    `${width}x${height}`,
    'xc:black',
    ...Object.keys(details.images_to_holds).flatMap((image) => [
      join(repository, 'packages/web/public/images', entry.boardName, image),
      '-resize',
      `${width}x${height}!`,
      '-composite',
    ]),
    join(directory, 'board.png'),
  ]);
  boards[board.key] = { width, height, photo: `${board.key}/board.png` };
}

// Rust-encoded samples to check the renderer's uniform patching against, byte for byte.
const validation = sheets
  .find((sheet) => sheet.id === 'I-ghost-peek-standby')!
  .frames.concat(sheets.find((sheet) => sheet.id === 'A-shipped-wall-swap')!.frames);
const packetJson: Record<string, unknown> = {};
const validations: Record<string, unknown>[] = [];
for (const plan of packets.values()) {
  const directory = join(output, plan.board, plan.dir);
  mkdirSync(directory);
  const [previous, current, next] = plan.climbs;
  const controls = [
    { name: 'base-0-2', lower: 0, upper: 2, progress: 0, pulse: 1, mirrored: false, swap: [0.5, 0.5, 1] },
    { name: 'base-1-0', lower: 1, upper: 0, progress: 0, pulse: 1, mirrored: false, swap: [0.5, 0.5, 1] },
    ...[0, 1, 2].map((slot) => ({
      name: `still-${slot}`,
      lower: slot,
      upper: slot,
      progress: 0,
      pulse: 1,
      mirrored: false,
      swap: [1, 0, 1],
    })),
  ];
  validation
    .filter((frame) => frame.packet === plan.dir && plan.board === KILTER.key)
    .forEach((frame, index) => {
      const name = `check-${index}`;
      controls.push({
        name,
        lower: frame.lower,
        upper: frame.upper,
        progress: 0,
        pulse: 1,
        mirrored: false,
        swap: frame.swap,
      });
      validations.push({
        board: plan.board,
        packet: plan.dir,
        name,
        lower: frame.lower,
        upper: frame.upper,
        swap: frame.swap,
      });
    });
  writeFileSync(join(directory, 'source-request.json'), JSON.stringify({ current, previous, next, strict: false }));
  writeFileSync(join(directory, 'controls.json'), JSON.stringify({ version: 1, samples: controls }));
  run(packetCli, [
    join(output, plan.board, 'config.json'),
    join(directory, 'source-request.json'),
    join(directory, 'out'),
    join(directory, 'controls.json'),
  ]);
  const description = JSON.parse(readFileSync(join(directory, 'out/packet.json'), 'utf8')) as {
    scenes: { offset: number; bytes: number; count: number; stamp_layers: number }[];
  };
  packetJson[`${plan.board}/${plan.dir}`] = {
    board: plan.board,
    dir: `${plan.board}/${plan.dir}/out`,
    scenes: description.scenes.map(({ offset, bytes, count, stamp_layers }) => ({
      offset,
      bytes,
      count,
      stampLayers: stamp_layers,
    })),
  };
}

const key = (board: string, packet: string) => `${board}/${packet}`;
writeFileSync(
  join(output, 'plan.json'),
  JSON.stringify({
    boards,
    packets: packetJson,
    validations: validations.map((check) => ({ ...check, packet: key(check.board as string, check.packet as string) })),
    sheets: sheets.map((sheet) => ({
      ...sheet,
      frames: sheet.frames.map((frame) => ({ ...frame, packet: key(sheet.board, frame.packet) })),
    })),
    motion: motion.map((track) => ({
      ...track,
      board: KILTER.key,
      commitsMs: MOTION_SCRIPT.commits,
      frames: track.frames.map((frame) => ({ ...frame, packet: key(KILTER.key, frame.packet) })),
    })),
  }),
);
console.log(
  JSON.stringify({
    output,
    packets: packets.size,
    sheets: sheets.length,
    tracks: motion.length,
    frames: motion.reduce((sum, track) => sum + track.frames.length, 0),
    validations: validations.length,
  }),
);
