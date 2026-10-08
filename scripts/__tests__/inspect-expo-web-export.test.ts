/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const inspectorScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'inspect-expo-web-export.mjs');

describe('Expo web export inspection', () => {
  let outputDirectory: string;
  let chunkDirectory: string;

  beforeEach(() => {
    outputDirectory = mkdtempSync(join(tmpdir(), 'inspect-expo-web-export-'));
    chunkDirectory = join(outputDirectory, '_expo', 'static', 'js', 'web');
    mkdirSync(chunkDirectory, { recursive: true });
  });

  afterEach(() => {
    rmSync(outputDirectory, { recursive: true, force: true });
  });

  function writeShell(scriptPaths: string[]): void {
    writeFileSync(
      join(outputDirectory, 'index.html'),
      `<html><body>${scriptPaths.map((scriptPath) => `<script src="${scriptPath}" defer></script>`).join('')}</body></html>`,
    );
  }

  function inspect(baseUrl?: string) {
    return spawnSync(process.execPath, [inspectorScript, outputDirectory, ...(baseUrl ? [baseUrl] : [])], {
      encoding: 'utf8',
    });
  }

  it.each(['', '/', '/app', '/app/'])(
    'reports every eager script and resolves async chunks with base URL "%s"',
    (baseUrl) => {
      const assetPrefix = baseUrl.replace(/\/+$/, '');
      writeShell([`${assetPrefix}/_expo/static/js/web/entry.js`, `${assetPrefix}/_expo/static/js/web/common.js`]);
      writeFileSync(join(chunkDirectory, 'entry.js'), `load("${assetPrefix}/_expo/static/js/web/route.js");`);
      writeFileSync(join(chunkDirectory, 'common.js'), 'globalThis.shared = true;');
      writeFileSync(join(chunkDirectory, 'route.js'), 'globalThis.route = true;');

      const result = inspect(baseUrl);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('eager JS: 2 file(s)');
      expect(result.stdout).toMatch(/entry\.js\s+raw=[\d,]+\s+br=[\d,]+/);
      expect(result.stdout).toMatch(/common\.js\s+raw=[\d,]+\s+br=[\d,]+/);
      expect(result.stdout).toMatch(/total raw=[\d,]+ brotli=[\d,]+/);
      expect(result.stdout).toContain('1 referenced async chunk path(s) all resolve');
    },
  );

  it('reports sizes and passes when the compressed payload exceeds the former 2,070,000-byte cap', () => {
    writeShell(['/_expo/static/js/web/entry.js']);
    writeFileSync(join(chunkDirectory, 'entry.js'), randomBytes(2_200_000));

    const result = inspect();
    const compressedBytes = result.stdout.match(/total raw=[\d,]+ brotli=([\d,]+)/)?.[1];

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`raw=${(2_200_000).toLocaleString()}`);
    expect(Number(compressedBytes?.replaceAll(',', ''))).toBeGreaterThan(2_070_000);
    expect(result.stdout).not.toContain('budget');
  });

  it('fails when the shell references a missing eager script', () => {
    writeShell(['/app/_expo/static/js/web/missing.js']);

    const result = inspect('/app');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('index.html references /app/_expo/static/js/web/missing.js');
    expect(result.stderr).toContain('does not exist on disk');
  });

  it('fails when an eager script references a missing async chunk', () => {
    writeShell(['/app/_expo/static/js/web/entry.js']);
    writeFileSync(join(chunkDirectory, 'entry.js'), 'load("/app/_expo/static/js/web/missing-route.js");');

    const result = inspect('/app');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bundles reference chunk(s) that do not exist on disk');
    expect(result.stderr).toContain('/app/_expo/static/js/web/missing-route.js');
  });

  it('fails when the shell contains no eager scripts', () => {
    writeShell([]);

    const result = inspect();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no <script src> found');
  });
});
