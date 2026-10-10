#!/usr/bin/env node
// Compose the approved portrait walkthrough into a wide desktop chapter layout.
import sharp from 'sharp';
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workDir = resolve(root, '.boardsesh/spray-walkthrough/landscape');
const source = resolve(root, 'packages/web/public/videos/help/spray-walls-walkthrough.mp4');
const photo = resolve(root, 'marketing/spray-walkthrough/wall-photo.jpg');
const mp4 = resolve(root, 'packages/web/public/videos/help/spray-walls-walkthrough-landscape.mp4');
const webm = resolve(root, 'packages/web/public/videos/help/spray-walls-walkthrough-landscape.webm');
const poster = resolve(root, 'packages/web/public/images/help/clips/spray-walls-walkthrough-landscape.webp');

const width = 1280;
const height = 720;
const panelWidth = 875;
const phoneWidth = width - panelWidth;
const maxBytes = 2_000_000;
const chapters = [
  {
    at: 0,
    eyebrow: '01 / THE PHOTO',
    title: ['One good', 'photo.'],
    body: ['Shoot square on, in portrait.', 'Keep the whole wall in frame.'],
  },
  {
    at: 39,
    eyebrow: '02 / SETUP',
    title: ['Make it', 'your wall.'],
    body: ['Name it, set the angle,', 'then choose your wall photo.'],
  },
  {
    at: 69,
    eyebrow: '03 / HOLDS',
    title: ['Check every', 'ring.'],
    body: ['Keep maybes and adjust sizes.', 'Add the holds it missed.'],
  },
  {
    at: 109,
    eyebrow: '04 / LATER',
    title: ['Keep the wall', 'current.'],
    body: ['Switch off, delete, or add.', 'Publish holds when done.'],
  },
  {
    at: 139,
    eyebrow: 'SPRAY WALLS',
    title: ['Ready to', 'climb.'],
    body: ['boardsesh.com/help/spray-walls'],
  },
] as const;

function run(command: string, args: string[]): Buffer {
  const result = spawnSync(command, args, { encoding: null, maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr?.toString('utf8') ?? result.error?.message ?? result.status}`);
  }
  return result.stdout;
}

function xml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[character] ?? character,
  );
}

async function writeCards(): Promise<string[]> {
  mkdirSync(workDir, { recursive: true });
  const background = await sharp(photo).resize(panelWidth, height, { fit: 'cover' }).blur(12).png().toBuffer();
  const wall = await sharp(photo).resize(166, 194, { fit: 'contain', background: '#110a20' }).png().toBuffer();
  const tint = Buffer.from(
    `<svg width="${width}" height="${height}"><rect width="${panelWidth}" height="${height}" fill="#110a20" opacity=".78"/></svg>`,
  );
  const paths: string[] = [];
  for (const [index, chapter] of chapters.entries()) {
    const title = chapter.title
      .map(
        (line, lineIndex) =>
          `<text x="56" y="${207 + lineIndex * 82}" fill="#ffffff" font-family="Arial, sans-serif" font-size="76" font-weight="800">${xml(line)}</text>`,
      )
      .join('');
    const body = chapter.body
      .map(
        (line, lineIndex) =>
          `<text x="58" y="${390 + lineIndex * 43}" fill="#e0d8eb" font-family="Arial, sans-serif" font-size="29">${xml(line)}</text>`,
      )
      .join('');
    const progress = chapters
      .map(
        (_, step) =>
          `<rect x="${56 + step * 79}" y="655" width="65" height="5" rx="2.5" fill="${step <= index ? '#b893ef' : '#72617d'}"/>`,
      )
      .join('');
    const artwork = Buffer.from(`<svg width="${width}" height="${height}">
      <rect x="${panelWidth - 3}" width="3" height="${height}" fill="#b893ef"/>
      <text x="58" y="84" fill="#c9aaff" font-family="Arial, sans-serif" font-size="23" font-weight="800" letter-spacing="3">${xml(chapter.eyebrow)}</text>
      ${title}${body}
      <rect x="645" y="439" width="184" height="212" rx="18" fill="#251a36" stroke="#b893ef" stroke-width="2"/>
      <text x="58" y="619" fill="#cabfd4" font-family="Arial, sans-serif" font-size="20" font-weight="700">SPRAY WALL WALKTHROUGH</text>
      ${progress}
    </svg>`);
    const path = resolve(workDir, `chapter-${index}.png`);
    await sharp({ create: { width, height, channels: 4, background: '#110a20' } })
      .composite([
        { input: background, left: 0, top: 0 },
        { input: tint, left: 0, top: 0 },
        { input: artwork, left: 0, top: 0 },
        { input: wall, left: 654, top: 448 },
      ])
      .png()
      .toFile(path);
    paths.push(path);
  }
  return paths;
}

function encodeLandscape(cards: string[]): void {
  const inputs = ['-i', source, ...cards.flatMap((card) => ['-loop', '1', '-framerate', '30', '-i', card])];
  const overlays = chapters.slice(1).map((chapter, index) => {
    const base = index === 0 ? '[1:v]' : `[chapter${index}]`;
    return `${base}[${index + 2}:v]overlay=0:0:enable='gte(t,${chapter.at})'[chapter${index + 1}]`;
  });
  const filter = [
    ...overlays,
    `[0:v]scale=${phoneWidth}:${height}:flags=lanczos,setsar=1[phone]`,
    `[chapter${chapters.length - 1}][phone]overlay=${panelWidth}:0:shortest=1,format=yuv420p[out]`,
  ].join(';');
  run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputs,
    '-filter_complex',
    filter,
    '-map',
    '[out]',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-tune',
    'animation',
    '-crf',
    '35',
    '-movflags',
    '+faststart',
    mp4,
  ]);
  run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    mp4,
    '-an',
    '-c:v',
    'libvpx-vp9',
    '-crf',
    '52',
    '-b:v',
    '0',
    '-row-mt',
    '1',
    '-deadline',
    'good',
    '-cpu-used',
    '2',
    webm,
  ]);
}

async function main(): Promise<void> {
  const cards = await writeCards();
  encodeLandscape(cards);
  const posterFrame = run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    '2',
    '-i',
    mp4,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    'pipe:1',
  ]);
  await sharp(posterFrame).webp({ quality: 82 }).toFile(poster);
  for (const asset of [mp4, webm]) {
    const bytes = statSync(asset).size;
    console.log(`${asset}: ${bytes} bytes`);
    if (bytes > maxBytes) throw new Error(`${asset} exceeds the ${maxBytes} byte asset guard`);
  }
  console.log(`${poster}: ${statSync(poster).size} bytes`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
