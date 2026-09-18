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
import {
  createDesignPreviewPublisher,
  designPreviewFiles,
  DESIGN_PREVIEW_VIEWPORTS,
} from '../../../scripts/lib/design-previews';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '../../../docs/design');

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
  const fullCapture = targets.includes(DEFAULT_ROOT);
  if (files.length === 0) {
    if (fullCapture) {
      createDesignPreviewPublisher().finish([]);
      console.log('[design:mockups] no HTML mockups remain; cleared the preview index');
      return;
    }
    console.error('[design:mockups] no .html wireframes found');
    process.exitCode = 1;
    return;
  }

  const outputs = designPreviewFiles(files);
  const { publish, finish } = createDesignPreviewPublisher();
  // Keep review downloads small: these flat-colour renders compress well to a
  // palette PNG at 1x. Generated PNGs are ignored; only their public links enter Git.
  const browser = await chromium.launch();
  try {
    for (const file of files) {
      const name = basename(file, '.html');
      for (const viewport of DESIGN_PREVIEW_VIEWPORTS) {
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
        console.log(`[design:mockups] ${await publish(output)}`);
      }
    }
    finish(fullCapture ? outputs : undefined);
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Design preview capture failed');
  process.exitCode = 1;
});
