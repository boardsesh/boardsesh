// Board motion lab previews, step 2: compile PreviewRender.swift with the real
// shader and swap look sources, render every prepared frame on this Mac's GPU,
// and lay each variant out as one contact sheet. With --golden, also prove the
// look-off shader is byte-identical to the shader at --baseline (default HEAD)
// on the Aura transition golden's 42 samples. See README.md.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../..');
const native = join(repository, 'packages/mobile/modules/climb-overlay-gpu/ios');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`Missing ${name}`);
  return value;
}
const home = (path) => resolve(path.replace(/^~(?=\/)/, process.env.HOME ?? '~'));

const work = home(option('--work'));
const out = home(option('--out'));
const golden = process.argv.includes('--golden') ? home(option('--golden')) : null;
const baselineRef = option('--baseline', 'HEAD');

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.slice(0, 3).join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

if (existsSync(out)) throw new Error(`Output exists, pick a fresh directory: ${out}`);
const build = join(out, 'build');
mkdirSync(build, { recursive: true });

// The shader as it was, renamed so both compile into one executable.
const baseline = run('git', [
  '-C',
  repository,
  'show',
  `${baselineRef}:packages/mobile/modules/climb-overlay-gpu/ios/ClimbOverlayShader.swift`,
]);
if (baseline.split('enum ClimbOverlayShader {').length !== 2) throw new Error('Baseline shader envelope changed');
writeFileSync(
  join(build, 'BaselineShader.swift'),
  baseline.replace('enum ClimbOverlayShader {', 'enum BaselineShader {'),
);

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
  '-o',
  executable,
]);

const frames = join(out, 'frames');
console.log(run(executable, ['preview', work, frames], { timeout: 300_000 }).trim());

// One contact sheet per variant: its ten frames in time order, labelled. ImageMagick
// has no default font on macOS, so name a system one.
const MONTAGE_FONT = ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc'].find(
  (font) => existsSync(font),
);
if (!MONTAGE_FONT) throw new Error('No system font for the contact sheet labels');
const timeline = JSON.parse(readFileSync(join(work, 'timeline.json'), 'utf8'));
const sheets = [];
for (const variant of timeline.variants) {
  const samples = timeline.samples.filter((sample) => sample.variant === variant.id);
  const sheet = join(out, `${variant.letter}-${variant.id}.png`);
  run('magick', [
    'montage',
    ...samples.flatMap((sample) => ['-label', sample.label, join(frames, `${sample.name}.png`)]),
    '-tile',
    `${Math.ceil(samples.length / 2)}x2`,
    '-geometry',
    '540x752+6+6',
    '-background',
    '#0e0b16',
    '-fill',
    '#eeeeee',
    '-font',
    MONTAGE_FONT,
    '-pointsize',
    '22',
    '-title',
    `${variant.letter} · ${variant.name} — ${timeline.climbs[0]} → ${timeline.climbs[1]} (Next)`,
    sheet,
  ]);
  sheets.push(sheet);
}

let parity = null;
if (golden) {
  parity = run(executable, ['parity', golden, join(out, 'parity')], { timeout: 300_000 }).trim();
  console.log(parity);
}
writeFileSync(join(out, 'sheets.json'), JSON.stringify({ sheets, parity: parity && JSON.parse(parity) }, null, 2));
console.log(JSON.stringify({ sheets }, null, 2));
