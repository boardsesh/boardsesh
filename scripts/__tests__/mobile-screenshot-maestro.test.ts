import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runScreenshotMaestro } from '../mobile-screenshot-maestro';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runNode(script: string, options: Parameters<typeof runScreenshotMaestro>[1] = {}) {
  return runScreenshotMaestro(['-e', script], {
    command: process.execPath,
    timeoutMs: 5000,
    gracePeriodMs: 50,
    onStderr: () => {},
    ...options,
  });
}

describe('CPP Maestro subprocess supervision', () => {
  it('keeps successful and unsuccessful actual process exit codes', async () => {
    expect(await runNode('process.exit(0)')).toBe(0);
    expect(await runNode('process.exit(7)')).toBe(7);
  });

  it('stops a hanging main-thread exception split across stderr chunks', async () => {
    const stderr: Buffer[] = [];
    const started = Date.now();
    const status = await runNode(
      `process.on('SIGTERM', () => {});
       process.stderr.write('Exception in thr');
       setTimeout(() => process.stderr.write('ead "main" NativeDriverFailure\\n'), 50);
       setInterval(() => {}, 1000);`,
      { onStderr: (chunk) => stderr.push(chunk) },
    );
    expect(status).toBe(1);
    expect(Buffer.concat(stderr).toString()).toContain('Exception in thread "main" NativeDriverFailure');
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('fails an exception even if the child exits successfully during shutdown', async () => {
    expect(
      await runNode(
        `process.on('SIGTERM', () => process.exit(0));
         process.stderr.write('Exception in thread "main" NativeDriverFailure\\n');
         setInterval(() => {}, 1000);`,
      ),
    ).toBe(1);
  });

  it('does not mistake quoted or truncated inline exception text for a JVM crash', async () => {
    expect(
      await runNode(
        `process.stderr.write('Quoted: Exception in thread "main" is sample text\\n');
         process.stderr.write('a'.repeat(1000) + 'Exception in thread "main"');
         setTimeout(() => process.stderr.write(' is inline text\\n'), 50);`,
      ),
    ).toBe(0);
  });

  it('fails a stalled process that ignores SIGTERM within the configured limit', async () => {
    const started = Date.now();
    expect(await runNode("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", { timeoutMs: 250 })).toBe(1);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('fails closed when Maestro cannot be launched', async () => {
    expect(await runScreenshotMaestro([], { command: '/missing/maestro', gracePeriodMs: 50 })).toBe(1);
  });

  it.skipIf(process.platform === 'win32')(
    'terminates descendants that retain stderr after their parent exits',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'cpp-maestro-descendant-'));
      temporaryDirectories.push(directory);
      const pidFile = join(directory, 'child.pid');
      const descendant = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
      const status = await runNode(
        `const {spawn} = require('node:child_process');
       const {writeFileSync} = require('node:fs');
       const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: ['ignore', 'ignore', 2]});
       writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
       setTimeout(() => process.exit(0), 200);`,
      );
      expect(status).toBe(0);
      const descendantPid = Number(readFileSync(pidFile, 'utf8'));
      const processState = spawnSync('ps', ['-o', 'stat=', '-p', String(descendantPid)], {
        encoding: 'utf8',
      }).stdout.trim();
      expect(processState === '' || processState.startsWith('Z')).toBe(true);
    },
  );
});
