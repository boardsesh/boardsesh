#!/usr/bin/env node
/**
 * Captures the static design wireframes in docs/design/** to PNG at desktop and
 * phone width, so a reviewer can scan the set without opening four files.
 *
 * Deliberately NOT a Playwright project: playwright.config.ts wires a
 * globalSetup that seeds the dev database, signs a test user in and prewarms SSR
 * routes, plus a webServer that boots `vp run dev`. These are `file://`
 * documents with no server behind them — they should not pay for any of that.
 *
 * Imports chromium from @playwright/test, not `playwright`: the bare package is
 * in the pnpm store but is not linked into packages/web.
 *
 * Usage: vp run design:mockups [-- <dir-or-file> ...]
 */
import { chromium } from '@playwright/test';
import sharp from 'sharp';
import { readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '../../../docs/design');

/** Capture widths. 1440 is the desktop review size; 390 is an iPhone viewport. */
const VIEWPORTS = [
  { width: 1440, height: 900, suffix: '1440' },
  { width: 390, height: 844, suffix: '390' },
] as const;

async function collectHtmlFiles(target: string): Promise<string[]> {
  if (statSync(target).isFile()) return [target];
  const entries = await readdir(target, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

async function main(): Promise<void> {
  // `vp run design:mockups -- <path>` forwards the `--` separator too.
  const requested = process.argv.slice(2).filter((value) => value !== '--');
  const targets = requested.length > 0 ? requested.map((value) => resolve(value)) : [DEFAULT_ROOT];

  const missing = targets.filter((target) => !existsSync(target));
  if (missing.length > 0) {
    console.error(`[design:mockups] not found: ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const files = (await Promise.all(targets.map(collectHtmlFiles))).flat();
  if (files.length === 0) {
    console.error('[design:mockups] no .html wireframes found');
    process.exitCode = 1;
    return;
  }

  // deviceScaleFactor stays at 1: scripts/check-large-files.mjs caps a single
  // file at 2MB, and a full-page @2x capture of a long wireframe clears that.
  // The captures then go through a palette quantise — these are flat-colour UI
  // renders with a few hundred distinct colours, so 8-bit costs nothing visible
  // and takes a long page from ~1.8MB to a few hundred KB.
  const browser = await chromium.launch();
  try {
    for (const file of files) {
      const name = basename(file, '.html');
      for (const viewport of VIEWPORTS) {
        const page = await browser.newPage({
          viewport: { width: viewport.width, height: viewport.height },
          deviceScaleFactor: 1,
          colorScheme: 'dark',
        });
        await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle' });
        const output = join(file, '..', `${name}-${viewport.suffix}.png`);
        const raw = await page.screenshot({ fullPage: true });
        await page.close();
        await sharp(raw).png({ palette: true, quality: 90, effort: 9 }).toFile(output);
        console.log(`[design:mockups] ${output.replace(`${process.cwd()}/`, '')}`);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
