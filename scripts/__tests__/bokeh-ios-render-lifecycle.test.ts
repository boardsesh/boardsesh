/// <reference types="node" />

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const executeFile = promisify(execFile);
const bokehDirectory = new URL('../../packages/mobile/modules/frosted-bokeh-gpu/ios/', import.meta.url);

describe.skipIf(process.platform !== 'darwin')('iOS bokeh preparation and command lifecycle', () => {
  it('keeps UI callers responsive and ignores stale GPU failures', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'boardsesh-bokeh-lifecycle-'));
    try {
      const executable = join(temporaryDirectory, 'bokeh-tests');
      await executeFile(
        'vp',
        [
          'exec',
          'swiftc',
          '-swift-version',
          '5',
          '-module-cache-path',
          join(temporaryDirectory, 'swift-cache'),
          fileURLToPath(new URL('BokehRenderLifecycle.swift', bokehDirectory)),
          fileURLToPath(new URL('tests/BokehRenderLifecycleTests.swift', bokehDirectory)),
          '-o',
          executable,
        ],
        { timeout: 120_000, maxBuffer: 1024 * 1024 },
      );
      const { stdout } = await executeFile('vp', ['exec', executable], {
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      });
      expect(stdout.trim()).toBe('PASS bokeh async compilation and command lifecycle');
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }, 150_000);
});
