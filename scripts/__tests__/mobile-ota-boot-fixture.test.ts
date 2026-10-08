/// <reference types="node" />

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOOT_FIXTURE_COMMIT_TIME_MS } from '../lib/ota-boot-check';

const checker = resolve(import.meta.dirname, '..', 'mobile-ota-boot-check.ts');
const stamp = (manifestPath: string) =>
  spawnSync(
    process.execPath,
    ['--experimental-strip-types', checker, 'stamp-embedded-fixture', '--manifest', manifestPath],
    { encoding: 'utf8' },
  );

describe('generated embedded fixture command', () => {
  it('stamps the requested file safely and preserves surrounding JS bytes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ota-fixture-command-'));
    try {
      const manifestPath = join(directory, 'literal $(echo no); app.manifest');
      const manifest = {
        id: '4f2ebe91-b04a-456a-84a8-a28e61bab715',
        commitTime: 1791502215000,
        assets: [{ hash: 'kept' }],
      };
      const bundlePath = join(directory, 'main.jsbundle');
      const bundle = Buffer.from([0, 255, 31, 7]);
      writeFileSync(manifestPath, JSON.stringify(manifest));
      writeFileSync(bundlePath, bundle);
      const result = stamp(manifestPath);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('1791502215000 -> 946684800000');
      expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual({
        ...manifest,
        commitTime: BOOT_FIXTURE_COMMIT_TIME_MS,
      });
      expect(readFileSync(bundlePath)).toEqual(bundle);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails without replacing malformed output or accepting missing generated files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ota-fixture-command-'));
    try {
      const manifestPath = join(directory, 'app.manifest');
      const malformed = '{"id":"not-a-uuid","commitTime":1791502215000,"assets":[]}';
      writeFileSync(manifestPath, malformed);
      expect(stamp(manifestPath).status).not.toBe(0);
      expect(readFileSync(manifestPath, 'utf8')).toBe(malformed);
      expect(stamp(join(directory, 'missing.manifest')).status).not.toBe(0);
      expect(stamp(directory).status).not.toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
