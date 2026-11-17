import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SAMPLE_TIMEOUT_MS = 5_000;
export const WORKER_TIMEOUT_MS = 30 * 60_000;
export const MAX_SAMPLES = 24;
interface ProcessRow {
  pid: number;
  parent: number;
  command: string;
}
export function parseProcessRows(output: string): ProcessRow[] {
  return output.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3] }] : [];
  });
}
export function sampleTargets(
  rows: ProcessRow[],
  workerPid: number,
  springBoardPids: ReadonlySet<number>,
  simulatorLaunchctlPids: ReadonlySet<number>,
): ProcessRow[] {
  const owned = new Set([workerPid]);
  for (let pass = 0; pass < rows.length; pass++) {
    let changed = false;
    for (const row of rows)
      if (owned.has(row.parent) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
    if (!changed) break;
  }
  return rows.filter(
    (row) =>
      (owned.has(row.pid) && ['simctl', 'launchctl', 'xcrun'].includes(basename(row.command))) ||
      (springBoardPids.has(row.pid) && basename(row.command) === 'SpringBoard') ||
      (simulatorLaunchctlPids.has(row.pid) && basename(row.command) === 'launchctl'),
  );
}
export function belongsToSimulator(environment: string, udid: string): boolean {
  if (!/^[A-F0-9-]{36}$/i.test(udid)) return false;
  return new RegExp(`(?:^|\\s)SIMULATOR_UDID=${udid}(?:\\s|$)`, 'i').test(environment);
}
export function sampleArgs(pid: number, output: string): string[] {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid sample PID');
  return [String(pid), '1', '10', '-file', output];
}
function command(program: string, args: string[], timeout: number) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: [result.stderr, result.error?.message].filter(Boolean).join('\n'),
    signal: result.signal,
  };
}
async function worker(source: string, output: string): Promise<void> {
  const mark = (stage: string) =>
    appendFileSync(join(output, 'worker.jsonl'), JSON.stringify({ at: new Date().toISOString(), stage }) + '\n');
  const checked = (args: string[], timeout = 60_000) => {
    const result = command('xcrun', args, timeout);
    if (result.status !== 0) throw new Error(`${args.slice(0, 3).join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  // The frozen source owns all install decisions and original command deadlines.
  const hinge = (await import(
    pathToFileURL(join(source, 'scripts/lib/ios-duo-hinge.ts')).href
  )) as typeof import('./lib/ios-duo-hinge');
  const boot = (await import(
    pathToFileURL(join(source, 'scripts/lib/ios-capture-boot.ts')).href
  )) as typeof import('./lib/ios-capture-boot');
  const runtimes = JSON.parse(checked(['simctl', 'list', 'runtimes', '--json'])) as {
    runtimes: Array<{
      identifier: string;
      version: string;
      isAvailable: boolean;
      supportedDeviceTypes?: Array<{ identifier: string }>;
    }>;
  };
  const type = 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo';
  const runtime = runtimes.runtimes.filter(
    (entry) =>
      entry.isAvailable &&
      entry.version === '27.2' &&
      entry.identifier.includes('iOS') &&
      (!entry.supportedDeviceTypes || entry.supportedDeviceTypes.some((device) => device.identifier === type)),
  )[0];
  if (!runtime) throw new Error('Required available iOS 27.2 Duo runtime missing');
  mark('create fresh Duo');
  const udid = checked(['simctl', 'create', `Boardsesh Duo diagnosis ${process.pid}`, type, runtime.identifier]);
  if (!/^[A-F0-9-]{36}$/i.test(udid)) throw new Error('Invalid created simulator UDID');
  writeFileSync(join(output, 'simulator-udid.txt'), udid);
  try {
    mark('boot');
    boot.bootIosCaptureDevice({
      device: { udid, state: 'Shutdown' },
      debugDir: output,
      run: (args, timeout) => command('xcrun', args, timeout),
    });
    mark('compile historical helper');
    const library = hinge.buildDuoHingeLibrary(join(output, 'library'));
    mark('install historical helper');
    hinge.installDuoHinge(udid, library, hinge.duoHingeLogPath(udid));
    mark('install success');
  } finally {
    mark('shutdown owned simulator');
    const result = command('xcrun', ['simctl', 'shutdown', udid], 30_000);
    writeFileSync(join(output, 'shutdown.json'), JSON.stringify(result));
  }
}
async function observe(source: string, output: string): Promise<number> {
  mkdirSync(output, { recursive: true });
  const retain = (path: string, contents: string | Buffer) => {
    try {
      appendFileSync(path, contents);
    } catch {
      /* Evidence failure must not change the historical child. */
    }
  };
  // simctl-spawned launchctl is parented by simulator launchd, not this worker.
  // Keep only newly appeared launchctl candidates; never capture their arguments/environment.
  const baselinePids = new Set(
    parseProcessRows(command('/bin/ps', ['-axo', 'pid=,ppid=,comm='], 3_000).stdout).map((row) => row.pid),
  );
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', fileURLToPath(import.meta.url), '--worker', source, output],
    {
      env: { ...process.env, SCREENSHOT_DEBUG_DIR: output },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  child.stdout.on('data', (chunk: Buffer) => retain(join(output, 'worker.log'), chunk));
  child.stderr.on('data', (chunk: Buffer) => retain(join(output, 'worker.log'), chunk));
  let finished = false;
  const completed = new Promise<number>((done) => {
    child.once('error', (error) => {
      finished = true;
      retain(join(output, 'worker.log'), error.message);
      done(1);
    });
    child.once('close', (code) => {
      finished = true;
      done(code ?? 1);
    });
  });
  const seen = new Map<number, number>();
  const counts = new Map<number, number>();
  const markers = new Map<string, string>();
  let samples = 0;
  const startedAt = Date.now();
  while (!finished && Date.now() - startedAt < WORKER_TIMEOUT_MS) {
    try {
      const snapshot = command('/bin/ps', ['-axo', 'pid=,ppid=,comm='], 3_000);
      const springBoards = new Set<number>();
      for (const name of readdirSync(output).filter(
        (name) => name.startsWith('boardsesh-duo-hinge-') && name.endsWith('.log'),
      )) {
        const contents = readFileSync(join(output, name), 'utf8');
        for (const match of contents.matchAll(/entry process=SpringBoard pid=(\d+)/g))
          springBoards.add(Number(match[1]));
        if (markers.get(name) !== contents) {
          // Observed-at time, not an invented native event timestamp. No environment values.
          retain(
            join(output, 'markers.jsonl'),
            JSON.stringify({ observedAt: new Date().toISOString(), file: name, contents }) + '\n',
          );
          markers.set(name, contents);
        }
      }
      const rows = parseProcessRows(snapshot.stdout);
      const simulatorLaunchctlPids = new Set<number>();
      let udid = '';
      try {
        udid = readFileSync(join(output, 'simulator-udid.txt'), 'utf8').trim();
      } catch {
        /* not created yet */
      }
      for (const row of rows.filter((row) => !baselinePids.has(row.pid) && basename(row.command) === 'launchctl')) {
        if (Date.now() - startedAt >= WORKER_TIMEOUT_MS) break;
        // Inspect this candidate's ownership privately. Never retain raw args/environment or errors.
        const ownership = command('/bin/ps', ['eww', '-p', String(row.pid), '-o', 'command='], 3_000);
        if (ownership.status === 0 && belongsToSimulator(ownership.stdout, udid)) simulatorLaunchctlPids.add(row.pid);
      }
      const targets = sampleTargets(rows, child.pid ?? -1, springBoards, simulatorLaunchctlPids);
      retain(
        join(output, 'processes.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), status: snapshot.status, targets }) + '\n',
      );
      for (const target of targets) {
        if (Date.now() - startedAt >= WORKER_TIMEOUT_MS) break;
        const first = seen.get(target.pid) ?? Date.now();
        seen.set(target.pid, first);
        if (Date.now() - first < 20_000 || (counts.get(target.pid) ?? 0) >= 2 || samples >= MAX_SAMPLES) continue;
        const path = join(output, `sample-${samples++}-${target.pid}.txt`);
        const result = command('/usr/bin/sample', sampleArgs(target.pid, path), SAMPLE_TIMEOUT_MS);
        retain(
          join(output, 'samples.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), pid: target.pid, path, ...result }) + '\n',
        );
        counts.set(target.pid, (counts.get(target.pid) ?? 0) + 1);
      }
    } catch (error) {
      retain(join(output, 'observer-errors.log'), `${new Date().toISOString()} ${String(error)}\n`);
    }
    await new Promise((done) => setTimeout(done, 5_000));
  }
  if (!finished && child.pid) {
    retain(join(output, 'worker.log'), '\nDiagnostic worker exceeded 30-minute overall bound.\n');
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already exited */
    }
  }
  const status = await completed;
  try {
    const udid = readFileSync(join(output, 'simulator-udid.txt'), 'utf8').trim();
    if (/^[A-F0-9-]{36}$/i.test(udid)) {
      retain(
        join(output, 'final-shutdown.json'),
        JSON.stringify(command('xcrun', ['simctl', 'shutdown', udid], 30_000)),
      );
    }
  } catch {
    /* Worker may have failed before simulator creation. */
  }
  return status;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const isWorker = process.argv[2] === '--worker';
  const [source, output] = process.argv.slice(isWorker ? 3 : 2).map((path) => resolve(path));
  if (!source || !output) throw new Error('Usage: duo-startup-diagnostics.ts source-directory output-directory');
  if (isWorker) await worker(source, output);
  else process.exitCode = await observe(source, output);
}
