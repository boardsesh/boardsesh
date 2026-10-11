import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('Cancellation test child did not reach its expected state');
}

async function isRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const status = await readFile(`/proc/${pid}/stat`, 'utf8');
      if (status.slice(status.lastIndexOf(')') + 2).startsWith('Z')) return false;
    }
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && ['ESRCH', 'ENOENT'].includes(String(error.code))) return false;
    throw error;
  }
}

describe('instructional CLI startup cancellation', () => {
  for (const { signal, exitCode } of [
    { signal: 'SIGINT', exitCode: 130 },
    { signal: 'SIGTERM', exitCode: 143 },
  ] as const) {
    it.skipIf(process.platform === 'win32')(
      `stops its startup group, runs uncancelled Compose cleanup, and releases the lock on ${signal}`,
      async () => {
        const parent = resolve('.boardsesh/tutorial-videos/cancellation-tests');
        await mkdir(parent, { recursive: true });
        const directory = await mkdtemp(resolve(parent, 'startup-'));
        const binaries = resolve(directory, 'bin');
        await mkdir(binaries);
        const readyPath = resolve(directory, 'up-ready.json');
        const stoppedPath = resolve(directory, 'compose-stopped.json');
        const workRoot = resolve(directory, 'work');
        const lockPath = resolve(workRoot, 'demo/running.lock');
        const apkPath = resolve(directory, 'test-only.apk');
        await writeFile(apkPath, 'Startup-only test; no emulator or APK installation occurs.');
        const dockerPath = resolve(binaries, 'docker');
        await writeFile(
          dockerPath,
          `#!${process.execPath}\n` +
            `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');\n` +
            `const args=process.argv.slice(2);\n` +
            `if(args.includes('up')){\n` +
            ` const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setInterval(()=>{},1000)"],{stdio:['ignore','inherit','inherit','ipc']});\n` +
            ` descendant.once('message',()=>writeFileSync(${JSON.stringify(readyPath)},JSON.stringify({commandPid:process.pid,descendantPid:descendant.pid,args})));\n` +
            ` setInterval(()=>{},1000);\n` +
            `}else if(args.includes('stop')){writeFileSync(${JSON.stringify(stoppedPath)},JSON.stringify({args}));}\n` +
            `else{throw new Error('Unexpected fake Docker invocation');}\n`,
        );
        await chmod(dockerPath, 0o755);
        let cli: ChildProcess | undefined;
        let ownedCommandPid: number | undefined;
        let log = '';
        try {
          cli = spawn(
            process.execPath,
            [
              '--import',
              'tsx',
              'scripts/instructional-video.ts',
              '--record-only',
              '--only',
              'progress',
              '--work-dir',
              workRoot,
              '--apk-path',
              apkPath,
            ],
            {
              cwd: resolve('.'),
              env: { ...process.env, PATH: `${binaries}${delimiter}${process.env.PATH ?? ''}` },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          cli.stdout?.on('data', (chunk: Buffer) => {
            log += chunk.toString();
          });
          cli.stderr?.on('data', (chunk: Buffer) => {
            log += chunk.toString();
          });
          const completed = new Promise<number | null>((done, reject) => {
            cli!.once('error', reject);
            cli!.once('close', done);
          });
          await waitUntil(() => {
            if (cli!.exitCode !== null)
              throw new Error(
                `CLI exited before startup cancellation (node=${process.execPath}, cwd=${resolve('.')}, code=${cli!.exitCode}, signal=${cli!.signalCode}): ${log}`,
              );
            return existsSync(readyPath);
          });
          const ready = JSON.parse(await readFile(readyPath, 'utf8')) as {
            commandPid: number;
            descendantPid: number;
            args: string[];
          };
          ownedCommandPid = ready.commandPid;
          expect(await isRunning(ready.commandPid)).toBe(true);
          expect(await isRunning(ready.descendantPid)).toBe(true);
          expect(await readFile(lockPath, 'utf8')).toBe(String(cli.pid));
          cli.kill(signal);
          await new Promise((done) => setTimeout(done, 100));
          cli.kill(signal);
          cli.kill(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
          expect(await completed).toBe(exitCode);
          await waitUntil(async () => !(await isRunning(ready.commandPid)) && !(await isRunning(ready.descendantPid)));
          const stopped = JSON.parse(await readFile(stoppedPath, 'utf8')) as { args: string[] };
          expect(stopped.args).toContain('stop');
          expect(stopped.args).not.toContain('down');
          expect(stopped.args).not.toContain('-v');
          expect(stopped.args).toContain(ready.args[ready.args.indexOf('-p') + 1]);
          expect(existsSync(lockPath)).toBe(false);
        } finally {
          if (cli && cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
          if (ownedCommandPid) {
            try {
              process.kill(-ownedCommandPid, 'SIGKILL');
            } catch {
              /* owned test command already exited */
            }
          }
        }
      },
      30_000,
    );
  }
});
