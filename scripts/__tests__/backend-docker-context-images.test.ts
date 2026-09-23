import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { copyDirectory, services } from '../create-service-docker-context.mjs';

/**
 * The backend image carries the board photos because `GET /og/climb` composites
 * them onto the share card. Every photo is committed twice — a `.png` and the
 * `.webp` that `packages/web/scripts/convert-to-webp.sh` makes from it — and the
 * renderer only ever opens the WebP, so the PNGs were 52 MB of a 74 MB tree
 * pulled on every deploy and never read.
 *
 * `board-art-is-webp.test.ts` guards the other half: that no catalogue path ever
 * asks for a raster this exclusion leaves behind.
 */
describe('backend Docker context', () => {
  const scratchDirs: string[] = [];

  afterAll(() => {
    for (const directory of scratchDirs) rmSync(directory, { recursive: true, force: true });
  });

  it('still ships the board images tree', () => {
    expect(services.backend.extraSourceDirs).toEqual(['packages/web/public/images']);
  });

  it('leaves the PNG originals out of it', () => {
    expect(services.backend.extraSourceDirExcludeExtensions).toEqual(['.png']);
  });

  it('keeps the exclusion scoped to the service that asked for it', () => {
    // Declared once, by the backend. A second service opting in — the web image
    // serves icon PNGs — would be a silent 404 rather than a build failure.
    const optedIn = Object.entries(services)
      .filter(([, config]) => config.extraSourceDirExcludeExtensions !== undefined)
      .map(([serviceName]) => serviceName);

    expect(optedIn).toEqual(['backend']);
  });

  it('drops the excluded extension at every depth, and keeps everything else', () => {
    // Exercised rather than read off the source. The tree is
    // `images/<board>/<layout>/…`, so a filter that ran only on the first level
    // would exclude nothing at all — and asserting that by matching the text of
    // the recursive call breaks on a reformat while passing on a real bug.
    const source = mkdtempSync(join(tmpdir(), 'docker-context-source-'));
    const destination = mkdtempSync(join(tmpdir(), 'docker-context-out-'));
    scratchDirs.push(source, destination);

    mkdirSync(join(source, 'kilter', 'layout-1'), { recursive: true });
    writeFileSync(join(source, 'top.png'), 'png');
    writeFileSync(join(source, 'top.webp'), 'webp');
    writeFileSync(join(source, 'kilter', 'mid.png'), 'png');
    writeFileSync(join(source, 'kilter', 'mid.webp'), 'webp');
    writeFileSync(join(source, 'kilter', 'layout-1', 'deep.png'), 'png');
    writeFileSync(join(source, 'kilter', 'layout-1', 'deep.webp'), 'webp');

    copyDirectory(source, destination, source, source, ['.png']);

    const copied = walk(destination).sort();

    expect(copied).toEqual(['kilter/layout-1/deep.webp', 'kilter/mid.webp', 'top.webp']);
  });

  it('copies the whole tree when no extension is excluded', () => {
    // The exclusion has to be the only thing removing files: a recursion that
    // dropped directories would otherwise read as a working filter above.
    const source = mkdtempSync(join(tmpdir(), 'docker-context-source-'));
    const destination = mkdtempSync(join(tmpdir(), 'docker-context-out-'));
    scratchDirs.push(source, destination);

    mkdirSync(join(source, 'kilter', 'layout-1'), { recursive: true });
    writeFileSync(join(source, 'top.png'), 'png');
    writeFileSync(join(source, 'kilter', 'layout-1', 'deep.png'), 'png');

    copyDirectory(source, destination, source);

    expect(walk(destination).sort()).toEqual(['kilter/layout-1/deep.png', 'top.png']);
  });
});

function walk(directory: string, root = directory): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return walk(entryPath, root);
    return [relative(root, entryPath).split(sep).join('/')];
  });
}
