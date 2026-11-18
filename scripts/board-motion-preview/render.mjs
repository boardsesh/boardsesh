// Board motion lab previews, step 2: compile PreviewRender.swift with the real
// shader and swap look sources, render every prepared frame on this Mac's GPU,
// lay each contact sheet out, encode the motion previews and their A-vs-variant
// side-by-sides, and check that a look frame at W = (1, 0) and (0, 1) draws the
// still frame pixel for pixel on I's sheets. With --golden, also prove the shader
// with no look bound is byte-identical to the shader at --baseline (default:
// where this branch leaves origin/main) on the Aura transition golden's 42
// samples. See README.md.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../..');
const native = join(repository, 'packages/mobile/modules/climb-overlay-gpu/ios');
const SHADER = 'packages/mobile/modules/climb-overlay-gpu/ios/ClimbOverlayShader.swift';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`Missing ${name}`);
  return value;
}
const home = (path) => resolve(path.replace(/^~(?=\/)/, process.env.HOME ?? '~'));

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.slice(0, 3).join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

const work = home(option('--work'));
const out = home(option('--out'));
const golden = process.argv.includes('--golden') ? home(option('--golden')) : null;
const baselineRef = option('--baseline', run('git', ['-C', repository, 'merge-base', 'HEAD', 'origin/main']).trim());
// The shader before the look's ghost-halo ownership fix, for the cut check (any ref with the look).
const beforeFixRef = option('--before-fix', baselineRef);

if (existsSync(out)) throw new Error(`Output exists, pick a fresh directory: ${out}`);
const build = join(out, 'build');
mkdirSync(build, { recursive: true });

/** The shader at `ref`, renamed so several compile into one executable. */
function shaderAt(ref, name) {
  const source = run('git', ['-C', repository, 'show', `${ref}:${SHADER}`]);
  if (source.split('enum ClimbOverlayShader {').length !== 2) throw new Error(`Shader envelope changed at ${ref}`);
  writeFileSync(join(build, `${name}.swift`), source.replace('enum ClimbOverlayShader {', `enum ${name} {`));
}
shaderAt(baselineRef, 'BaselineShader');
shaderAt(beforeFixRef, 'BeforeFixShader');

const executable = join(build, 'board-motion-preview');
run('xcrun', [
  'swiftc',
  '-O',
  '-module-cache-path',
  join(build, 'module-cache'),
  join(here, 'PreviewRender.swift'),
  join(native, 'ClimbOverlayShader.swift'),
  join(native, 'ClimbOverlaySwapLook.swift'),
  join(native, 'ClimbOverlayPacketLayout.swift'),
  join(build, 'BaselineShader.swift'),
  join(build, 'BeforeFixShader.swift'),
  '-o',
  executable,
]);

const rendered = join(out, 'rendered');
console.log(run(executable, ['render', work, rendered], { timeout: 3_600_000 }).trim());

// One contact sheet per sheet id: its frames in time order, labelled. ImageMagick
// has no default font on macOS, so name a system one.
const font = ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc'].find((path) =>
  existsSync(path),
);
if (!font) throw new Error('No system font for the contact sheet labels');
const plan = JSON.parse(readFileSync(join(work, 'plan.json'), 'utf8'));
const sheetDirectory = join(out, 'sheets');
mkdirSync(sheetDirectory);
for (const sheet of plan.sheets) {
  const frames = join(rendered, 'sheets', sheet.id);
  run('magick', [
    'montage',
    ...sheet.frames.flatMap((frame, index) => ['-label', frame.label, join(frames, `${index}.png`)]),
    '-tile',
    `${Math.ceil(sheet.frames.length / 2)}x2`,
    '-geometry',
    '540x752+6+6',
    '-background',
    '#0e0b16',
    '-fill',
    '#eeeeee',
    '-font',
    font,
    '-pointsize',
    '22',
    '-title',
    sheet.title,
    join(sheetDirectory, `${sheet.id}.png`),
  ]);
}

// Side by side: A on the left, the variant on the right, each with its own labels above the board.
const motion = join(rendered, 'motion');
const sideBySide = [];
for (const name of readdirSync(motion).filter((file) => file.endsWith('.mp4') && !file.startsWith('A-'))) {
  const speed = name.endsWith('-0.25x.mp4') ? '0.25x' : '1x';
  const shipped = join(motion, `A-shipped-wall-swap-${speed}.mp4`);
  const target = join(motion, `A-vs-${name}`);
  run('ffmpeg', [
    '-loglevel',
    'error',
    '-y',
    '-i',
    shipped,
    '-i',
    join(motion, name),
    '-filter_complex',
    'hstack=inputs=2',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    target,
  ]);
  sideBySide.push(target);
}

// The swap's two ends against the still compositor. Written to the summary
// either way; a difference fails the run once the summary is out.
const endpointRun = spawnSync(executable, ['endpoints', work, join(out, 'endpoints')], {
  encoding: 'utf8',
  timeout: 600_000,
});
const endpoints = JSON.parse(readFileSync(join(out, 'endpoints', 'endpoints.json'), 'utf8'));
console.log(endpointRun.stdout.trim());

let parity = null;
if (golden) {
  parity = JSON.parse(run(executable, ['parity', golden, join(out, 'parity')], { timeout: 600_000 }).trim());
  console.log(JSON.stringify(parity));
}
const stats = JSON.parse(readFileSync(join(rendered, 'stats.json'), 'utf8'));
writeFileSync(join(out, 'summary.json'), JSON.stringify({ parity, endpoints, stats, sideBySide }, null, 2));
console.log(JSON.stringify({ sheets: readdirSync(sheetDirectory).length, videos: readdirSync(motion).length }));
if (endpointRun.status !== 0) {
  throw new Error(`A look frame at W = (1, 0) or (0, 1) differs from the still frame: ${join(out, 'endpoints')}`);
}
