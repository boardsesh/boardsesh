import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { stopTutorialCaptureProcess } from '../lib/instructional-video/capture';

function running(pid: number): boolean {
  try {
    const status = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/\) [ZX] /.test(status);
  } catch {
    return false;
  }
}

it.skipIf(process.platform !== 'linux')(
  'stops an owned descendant after its launcher exits, preserving another group',
  async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'tutorial-process-group-'));
    const descendantFile = resolve(directory, 'descendant.pid');
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const launcher = spawn(
      process.execPath,
      [
        '-e',
        `const {spawn} = require('node:child_process');
       const {existsSync} = require('node:fs');
       spawn(process.execPath, ['-e',
         "process.on('SIGINT', () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
         process.argv[1]], {stdio: 'ignore'});
       const ready = setInterval(() => { if (existsSync(process.argv[1])) { clearInterval(ready); process.exit(0); } }, 10);`,
        descendantFile,
      ],
      { detached: true, stdio: 'ignore' },
    );
    try {
      await once(launcher, 'exit', { signal: AbortSignal.timeout(5000) });
      expect(launcher.exitCode).toBe(0);
      expect(existsSync(descendantFile)).toBe(true);
      const descendantPid = Number(readFileSync(descendantFile, 'utf8'));
      expect(running(descendantPid)).toBe(true);
      await stopTutorialCaptureProcess(launcher);
      for (let attempt = 0; attempt < 50 && running(descendantPid); attempt++) await sleep(20);
      expect(running(descendantPid)).toBe(false);
      expect(running(unrelated.pid!)).toBe(true);
    } finally {
      for (const child of [launcher, unrelated]) {
        if (!child.pid) continue;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The owned group may already be gone.
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
  15000,
);
