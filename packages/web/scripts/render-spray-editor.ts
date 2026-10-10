#!/usr/bin/env node
// Compose real app captures with instructional captions. Never draws replacement UI.
import sharp from 'sharp';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialSurfaces } from '@boardsesh/velvet-tokens';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const rawDir = resolve(root, '.boardsesh/spray-editor/raw');
const workDir = resolve(root, '.boardsesh/spray-editor/render');
const videoDir = resolve(root, 'packages/web/public/videos/help');
const posterDir = resolve(root, 'packages/web/public/images/help/clips');
const palette = materialSurfaces.dark;
const fps = 15;
const maxBytes = 2_000_000;

type Scene = {
  id: string;
  kind?: 'explanation';
  file: string;
  start?: number;
  duration: number;
  title: string;
  body: string;
};
type Cut = { file: string; segments: { file: string; start: number; duration: number; speed?: number }[] };
type Edit = { capture: string; cuts?: Cut[]; scenes: Scene[] };
type Probe = { streams: { width: number; height: number }[]; format: { duration: string } };
type Layout = {
  name: string;
  width: number;
  height: number;
  textWidth: number;
  titleY: number;
  bodyY: number;
  titleSize: number;
  bodySize: number;
  footage: { x: number; y: number; width: number; height: number };
};

const layouts: Layout[] = [
  {
    name: 'spray-holds-editor',
    width: 720,
    height: 1280,
    textWidth: 640,
    titleY: 88,
    bodyY: 133,
    titleSize: 39,
    bodySize: 24,
    footage: { x: 24, y: 245, width: 672, height: 1011 },
  },
  {
    name: 'spray-holds-editor-landscape',
    width: 1280,
    height: 720,
    textWidth: 640,
    titleY: 229,
    bodyY: 313,
    titleSize: 45,
    bodySize: 29,
    footage: { x: 736, y: 24, width: 520, height: 672 },
  },
];

function run(command: string, args: string[]): Buffer {
  const result = spawnSync(command, args, { encoding: null, maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command}: ${result.stderr?.toString('utf8') ?? result.error?.message ?? result.status}`);
  }
  return result.stdout;
}

function probe(path: string): Probe {
  return JSON.parse(
    run('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height:format=duration',
      '-of',
      'json',
      path,
    ]).toString('utf8'),
  ) as Probe;
}

function xml(content: string): string {
  return content.replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character] ?? character,
  );
}

function wrap(content: string, columns: number): string[] {
  const lines: string[] = [];
  for (const word of content.split(' ')) {
    const last = lines.length - 1;
    if (last < 0 || lines[last].length + word.length + 1 > columns) lines.push(word);
    else lines[last] += ` ${word}`;
  }
  return lines;
}

function isStill(scene: Scene): boolean {
  return ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(scene.file).toLowerCase());
}

function sourcePath(scene: Scene): string {
  return resolve(scene.kind === 'explanation' ? resolve(root, 'marketing/spray-walkthrough') : rawDir, scene.file);
}

function readEdit(): Edit {
  const edit = JSON.parse(readFileSync(resolve(root, 'marketing/spray-editor/edit.json'), 'utf8')) as Edit;
  if (!edit.scenes?.length) throw new Error('The editor cut has no scenes');
  const ids = new Set<string>();
  for (const scene of edit.scenes) {
    if (!/^[a-z0-9-]+$/.test(scene.id) || ids.has(scene.id)) throw new Error(`Invalid/duplicate scene: ${scene.id}`);
    ids.add(scene.id);
    if (basename(scene.file) !== scene.file) throw new Error(`${scene.id}: file must be inside the raw directory`);
    if (!(scene.duration > 0) || !Number.isFinite(scene.duration) || (scene.start ?? 0) < 0) {
      throw new Error(`${scene.id}: invalid duration/start`);
    }
    if (!scene.title || !scene.body) throw new Error(`${scene.id}: missing captions`);
  }
  return edit;
}

function prepareCuts(cuts: Cut[], checkOnly: boolean): Set<string> {
  const prepared = new Set<string>();
  for (const cut of cuts) {
    if (basename(cut.file) !== cut.file || !cut.segments.length) throw new Error('Invalid source cut');
    const inputPaths = cut.segments.map((segment) => {
      if (
        basename(segment.file) !== segment.file ||
        segment.file === cut.file ||
        !Number.isFinite(segment.start) ||
        segment.start < 0 ||
        !Number.isFinite(segment.duration) ||
        segment.duration <= 0 ||
        !Number.isFinite(segment.speed ?? 1) ||
        (segment.speed ?? 1) <= 0
      )
        throw new Error('Invalid cut segment');
      const path = resolve(rawDir, segment.file);
      if (!existsSync(path)) throw new Error(`Missing cut source: ${path}`);
      if (segment.start + segment.duration > Number(probe(path).format.duration) + 0.1) {
        throw new Error(`${segment.file}: cut extends past the recording`);
      }
      return path;
    });
    prepared.add(cut.file);
    if (checkOnly) continue;
    const output = resolve(rawDir, cut.file);
    if (
      existsSync(output) &&
      [resolve(root, 'marketing/spray-editor/edit.json'), ...inputPaths].every(
        (path) => statSync(path).mtimeMs <= statSync(output).mtimeMs,
      )
    )
      continue;
    const filters = cut.segments.map(
      (segment, index) =>
        `[${index}:v]fps=${fps},trim=start=${segment.start}:duration=${segment.duration},setpts=(PTS-STARTPTS)/${segment.speed ?? 1},fps=${fps},setsar=1[cut${index}]`,
    );
    filters.push(
      `${cut.segments.map((_, index) => `[cut${index}]`).join('')}concat=n=${cut.segments.length}:v=1:a=0[out]`,
    );
    run('ffmpeg', [
      '-v',
      'error',
      '-y',
      ...inputPaths.flatMap((path) => ['-i', path]),
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[out]',
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      output,
    ]);
  }
  return prepared;
}

async function makeCard(layout: Layout, scene: Scene, index: number, count: number): Promise<string> {
  const textX = 40;
  const titleLines = wrap(scene.title, Math.floor(layout.textWidth / (layout.titleSize * 0.57)));
  const bodyLines = wrap(scene.body, Math.floor(layout.textWidth / (layout.bodySize * 0.53)));
  if (titleLines.length > 1 || bodyLines.length > (scene.kind === 'explanation' ? 8 : layout.width === 720 ? 4 : 8)) {
    throw new Error(`${scene.id}: shorten captions to fit ${layout.name}`);
  }
  const body = bodyLines
    .map(
      (line, lineIndex) =>
        `<text x="${textX}" y="${layout.bodyY + lineIndex * layout.bodySize * 1.35}" font-size="${layout.bodySize}" fill="${palette.label}">${xml(line)}</text>`,
    )
    .join('');
  const card = `<svg width="${layout.width}" height="${layout.height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="${palette.background}" opacity="${scene.kind === 'explanation' ? 0.9 : 1}"/>
    <g font-family="Arial, sans-serif">
      <text x="${textX}" y="${layout.width === 720 ? 36 : 92}" font-size="18" font-weight="700" letter-spacing="2" fill="${palette.accent}">${scene.kind === 'explanation' ? 'EDITOR NOTES' : 'HOLD EDITOR'} · ${String(index + 1).padStart(2, '0')} / ${count}</text>
      <text x="${textX}" y="${layout.titleY}" font-size="${layout.titleSize}" font-weight="700" fill="${palette.label}">${xml(scene.title)}</text>
      ${body}
    </g>
  </svg>`;
  const path = resolve(workDir, `${layout.name}-${scene.id}.png`);
  if (scene.kind === 'explanation') {
    await sharp(sourcePath(scene))
      .resize(layout.width, layout.height, { fit: 'cover' })
      .blur(8)
      .composite([{ input: Buffer.from(card) }])
      .png()
      .toFile(path);
  } else await sharp(Buffer.from(card)).png().toFile(path);
  return path;
}

function composeScene(layout: Layout, scene: Scene, card: string): string {
  const footage = layout.footage;
  const path = resolve(workDir, `${layout.name}-${scene.id}.mp4`);
  if (scene.kind === 'explanation') {
    run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-loop',
      '1',
      '-framerate',
      String(fps),
      '-i',
      card,
      '-t',
      String(scene.duration),
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      path,
    ]);
    return path;
  }
  const sourceArgs = isStill(scene) ? ['-loop', '1', '-framerate', String(fps)] : [];
  // Simulator recordings have sparse, variable timestamps. Normalize before
  // trimming instead of input seeking, which can skip their final gestures.
  const filters = `[1:v]fps=${fps},trim=start=${scene.start ?? 0}:duration=${scene.duration},setpts=PTS-STARTPTS,scale=${footage.width}:${footage.height}:force_original_aspect_ratio=decrease:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=${scene.duration}[capture];[0:v][capture]overlay=x=${footage.x}+(${footage.width}-overlay_w)/2:y=${footage.y}+(${footage.height}-overlay_h)/2,format=yuv420p[out]`;
  run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-loop',
    '1',
    '-framerate',
    String(fps),
    '-i',
    card,
    ...sourceArgs,
    '-i',
    sourcePath(scene),
    '-filter_complex',
    filters,
    '-map',
    '[out]',
    '-an',
    '-t',
    String(scene.duration),
    '-r',
    String(fps),
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '18',
    path,
  ]);
  return path;
}

async function previewScene(layout: Layout, scene: Scene, card: string): Promise<void> {
  if (scene.kind === 'explanation') {
    await sharp(card)
      .webp({ quality: 90 })
      .toFile(resolve(workDir, `${layout.name}-${scene.id}-preview.webp`));
    return;
  }
  const source = sourcePath(scene);
  const frame = isStill(scene)
    ? readFileSync(source)
    : run('ffmpeg', [
        '-v',
        'error',
        '-i',
        source,
        '-vf',
        `fps=${fps},trim=start=${scene.start ?? 0},setpts=PTS-STARTPTS`,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        'pipe:1',
      ]);
  const footage = await sharp(frame)
    .resize(layout.footage.width, layout.footage.height, { fit: 'inside' })
    .png()
    .toBuffer({ resolveWithObject: true });
  await sharp(card)
    .composite([
      {
        input: footage.data,
        left: layout.footage.x + Math.floor((layout.footage.width - footage.info.width) / 2),
        top: layout.footage.y + Math.floor((layout.footage.height - footage.info.height) / 2),
      },
    ])
    .webp({ quality: 90 })
    .toFile(resolve(workDir, `${layout.name}-${scene.id}-preview.webp`));
}

function encode(layout: Layout, clips: string[], duration: number): void {
  const listPath = resolve(workDir, `${layout.name}-concat.txt`);
  // Filenames are generated above from validated scene IDs; concat uses relative paths.
  writeFileSync(listPath, clips.map((clip) => `file '${basename(clip)}'`).join('\n'));
  // The wide canvas overshoots the two-pass target more on static text cards.
  const budgetFraction = layout.width === 1280 ? 0.76 : 0.87;
  const bitrate = Math.floor((maxBytes * budgetFraction * 8) / duration);
  const common = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', listPath, '-an'];
  const passlog = resolve(workDir, `${layout.name}-pass`);
  const h264 = [
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-b:v',
    String(bitrate),
    '-pix_fmt',
    'yuv420p',
    '-passlogfile',
    passlog,
  ];
  run('ffmpeg', [...common, ...h264, '-pass', '1', '-f', 'null', '/dev/null']);
  run('ffmpeg', [...common, ...h264, '-pass', '2', '-movflags', '+faststart', resolve(videoDir, `${layout.name}.mp4`)]);
  const vp9 = [
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    String(bitrate),
    '-row-mt',
    '1',
    '-cpu-used',
    '2',
    '-passlogfile',
    `${passlog}-vp9`,
  ];
  run('ffmpeg', [...common, ...vp9, '-pass', '1', '-f', 'null', '/dev/null']);
  run('ffmpeg', [...common, ...vp9, '-pass', '2', resolve(videoDir, `${layout.name}.webm`)]);
}

async function contactSheet(layout: Layout, scenes: Scene[]): Promise<void> {
  const tileWidth = 320;
  const tileHeight = Math.round((layout.height / layout.width) * tileWidth);
  const tiles = await Promise.all(
    scenes.map(async (scene, index) => ({
      input: await sharp(resolve(workDir, `${layout.name}-${scene.id}-preview.webp`))
        .resize(tileWidth, tileHeight)
        .png()
        .toBuffer(),
      left: (index % 4) * tileWidth,
      top: Math.floor(index / 4) * tileHeight,
    })),
  );
  await sharp({
    create: {
      width: tileWidth * 4,
      height: tileHeight * Math.ceil(scenes.length / 4),
      channels: 3,
      background: palette.background,
    },
  })
    .composite(tiles)
    .webp({ quality: 88 })
    .toFile(resolve(workDir, `${layout.name}-contact.webp`));
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2).filter((flag) => flag !== '--');
  if (flags.some((flag) => flag !== '--check' && flag !== '--stills' && flag !== '--shots' && flag !== '--landscape')) {
    throw new Error('Use --check, --stills, --shots or --landscape');
  }
  if (flags.includes('--shots')) {
    const directory = resolve(root, 'packages/web/public/images/help');
    mkdirSync(directory, { recursive: true });
    for (const name of ['select', 'draw', 'corners']) {
      const source = resolve(rawDir, `${name}.png`);
      if (!existsSync(source)) throw new Error(`Missing screenshot: ${source}`);
      const output = resolve(directory, `spray-editor-${name}.webp`);
      const screenshot = sharp(source).resize(736, 1600, { fit: 'fill' });
      const dimensions = await screenshot.webp({ quality: 87, effort: 6 }).toFile(output);
      console.log(`[spray-editor] ${name}: ${dimensions.width} × ${dimensions.height}, ${dimensions.size} bytes`);
    }
    return;
  }
  const edit = readEdit();
  const duration = edit.scenes.reduce((seconds, scene) => seconds + scene.duration, 0);
  const prepared = prepareCuts(edit.cuts ?? [], flags.includes('--check'));
  const missing = edit.scenes.filter((scene) => !prepared.has(scene.file) && !existsSync(sourcePath(scene)));
  console.log(`[spray-editor] ${edit.scenes.length} scenes, ${duration} seconds; ${edit.capture}`);
  if (missing.length)
    throw new Error(`Missing real captures in ${rawDir}: ${missing.map((scene) => scene.file).join(', ')}`);
  for (const scene of edit.scenes) {
    if (flags.includes('--check') && prepared.has(scene.file)) continue;
    const dimensions = probe(sourcePath(scene));
    if (!dimensions.streams[0]?.width) throw new Error(`${scene.file}: no video/image stream`);
    if (!isStill(scene) && (scene.start ?? 0) >= Number(dimensions.format.duration)) {
      throw new Error(`${scene.file}: start is past the end of the recording`);
    }
  }
  if (flags.includes('--check')) return;
  for (const directory of [workDir, videoDir, posterDir]) mkdirSync(directory, { recursive: true });
  for (const layout of layouts.filter((candidate) => !flags.includes('--landscape') || candidate.width === 1280)) {
    const clips: string[] = [];
    for (const [index, scene] of edit.scenes.entries()) {
      console.log(`[spray-editor] ${layout.name}: ${scene.id}`);
      // Explanatory chapters are visibly text cards, never simulated app UI.
      const sceneLayout: Layout =
        scene.kind === 'explanation'
          ? {
              ...layout,
              textWidth: layout.width - 80,
              titleY: layout.width === 720 ? 330 : 270,
              bodyY: layout.width === 720 ? 430 : 365,
              titleSize: layout.width === 720 ? 44 : 56,
              bodySize: layout.width === 720 ? 34 : 32,
            }
          : layout;
      const card = await makeCard(sceneLayout, scene, index, edit.scenes.length);
      if (flags.includes('--stills')) {
        await previewScene(sceneLayout, scene, card);
        continue;
      }
      clips.push(composeScene(sceneLayout, scene, card));
    }
    if (flags.includes('--stills')) {
      await contactSheet(layout, edit.scenes);
      continue;
    }
    encode(layout, clips, duration);
    const frame = run('ffmpeg', [
      '-v',
      'error',
      '-ss',
      '1',
      '-i',
      resolve(videoDir, `${layout.name}.mp4`),
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      'pipe:1',
    ]);
    await sharp(frame)
      .webp({ quality: 85 })
      .toFile(resolve(posterDir, `${layout.name}.webp`));
    for (const extension of ['mp4', 'webm']) {
      const path = resolve(videoDir, `${layout.name}.${extension}`);
      const dimensions = probe(path);
      const bytes = statSync(path).size;
      if (dimensions.streams[0]?.width !== layout.width || dimensions.streams[0]?.height !== layout.height) {
        throw new Error(`${path}: incorrect output dimensions`);
      }
      if (Math.abs(Number(dimensions.format.duration) - duration) > 0.15)
        throw new Error(`${path}: incorrect duration`);
      if (bytes > maxBytes) throw new Error(`${path}: ${bytes} bytes exceeds ${maxBytes}`);
      console.log(`[spray-editor] ${layout.name}.${extension}: ${bytes} bytes, ${layout.width} × ${layout.height}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
