#!/usr/bin/env node
import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOCIAL_KEYS = new Set([
  'og:type',
  'og:site_name',
  'og:title',
  'og:description',
  'og:image',
  'og:image:width',
  'og:image:height',
  'twitter:card',
  'twitter:title',
  'twitter:description',
  'twitter:image',
]);

/** Add static preview metadata without duplicating the shell's icons or theme. */
export function patchExpoWebSocial(exportDir, basePrefix) {
  if (basePrefix !== '' && basePrefix !== '/app') {
    throw new Error('[patch-expo-web-social] unsupported export base prefix');
  }
  const imagePath = join(exportDir, 'og.png');
  if (!statSync(imagePath, { throwIfNoEntry: false })?.isFile() || statSync(imagePath).size === 0) {
    throw new Error(`[patch-expo-web-social] missing or empty preview image: ${imagePath}`);
  }
  const shellPath = join(exportDir, 'index.html');
  const shell = readFileSync(shellPath, 'utf8');
  if (!/<\/head>/i.test(shell)) {
    throw new Error('[patch-expo-web-social] index.html has no closing head');
  }
  const origin = basePrefix === '' ? 'https://app.boardsesh.com' : 'https://www.boardsesh.com';
  const imageUrl = `${origin}${basePrefix}/og.png`;
  const description = 'Browse climbs, build a queue, and climb with your crew.';
  const metadata = [
    ['property', 'og:type', 'website'],
    ['property', 'og:site_name', 'Boardsesh'],
    ['property', 'og:title', 'Boardsesh'],
    ['property', 'og:description', description],
    ['property', 'og:image', imageUrl],
    ['property', 'og:image:width', '1200'],
    ['property', 'og:image:height', '630'],
    ['name', 'twitter:card', 'summary_large_image'],
    ['name', 'twitter:title', 'Boardsesh'],
    ['name', 'twitter:description', description],
    ['name', 'twitter:image', imageUrl],
  ]
    .map(([attribute, key, content]) => `<meta ${attribute}="${key}" content="${content}">`)
    .join('\n');
  const withoutOwnedBlock = shell.replace(/<!-- boardsesh-social -->[\s\S]*?<!-- \/boardsesh-social -->/g, '');
  const withoutPreviousTags = withoutOwnedBlock.replace(/<meta\b[^>]*>/gi, (tag) => {
    const key = /\b(?:name|property)=["']([^"']*)["']/i.exec(tag)?.[1];
    return SOCIAL_KEYS.has(key?.toLowerCase()) ? '' : tag;
  });
  const patched = withoutPreviousTags.replace(
    /<\/head>/i,
    `<!-- boardsesh-social -->${metadata}<!-- /boardsesh-social --></head>`,
  );
  const stagingPath = join(exportDir, `.index.html.social-${process.pid}`);
  writeFileSync(stagingPath, patched);
  renameSync(stagingPath, shellPath);
  return imageUrl;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [exportDir, basePrefix = ''] = process.argv.slice(2);
    if (!exportDir) throw new Error('usage: patch-expo-web-social.mjs <export-dir> [base-prefix]');
    console.log(`[patch-expo-web-social] preview image ${patchExpoWebSocial(exportDir, basePrefix)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
