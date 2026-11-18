import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import type { Environment } from '../../partner-oauth-e2e/server-environment';

/**
 * Process and readiness helpers for the global setup: start a server under the
 * watchdog, stop its whole process group, wait for it to answer.
 */

const WATCHDOG = resolve(__dirname, '../../partner-oauth-e2e/watchdog.mjs');

export interface ManagedProcess {
  name: string;
  child: ChildProcess;
  logFile: string;
}

export function readEnvironmentFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}

export async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/**
 * Starts a server under `watchdog.mjs`, as the leader of its own process group,
 * so a killed test run never leaves `next dev` or the backend behind. A restart
 * writes the same log file again, so the log of the run that failed is the last one.
 */
export function startProcess(
  name: string,
  command: string,
  args: string[],
  cwd: string,
  environment: Environment,
  logDirectory: string,
): ManagedProcess {
  const logFile = join(logDirectory, `${name}.log`);
  const log = createWriteStream(logFile, { flags: 'a' });
  const child = spawn(process.execPath, [WATCHDOG, String(process.pid), command, ...args], {
    cwd,
    env: environment as unknown as NodeJS.ProcessEnv,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return { name, child, logFile };
}

function signalGroup(processGroup: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroup, signal);
  } catch {
    // The group is already empty.
  }
}

export async function stopProcess({ child }: ManagedProcess): Promise<void> {
  if (child.pid === undefined) return;
  const processGroup = child.pid;
  const running = child.exitCode === null && child.signalCode === null;
  const exited = running ? once(child, 'exit') : Promise.resolve();
  signalGroup(processGroup, 'SIGTERM');
  const forceKill = setTimeout(() => signalGroup(processGroup, 'SIGKILL'), 15_000);
  await exited;
  clearTimeout(forceKill);
  signalGroup(processGroup, 'SIGKILL');
}

function logTail(managed: ManagedProcess): string {
  try {
    return readFileSync(managed.logFile, 'utf8').split('\n').slice(-40).join('\n');
  } catch {
    return '(no log)';
  }
}

/** One request straight to a local server, as the edge would send it. Resolves with the status. */
export function probe(port: number, path: string, host: string, timeoutMs = 180_000): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        agent: false,
        timeout: timeoutMs,
        headers: { Host: host, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '127.0.0.1' },
      },
      (incoming) => {
        incoming.resume();
        incoming.on('end', () => resolveStatus(incoming.statusCode ?? 0));
      },
    );
    outgoing.on('timeout', () => outgoing.destroy(new Error(`${host}${path} took over ${timeoutMs} ms`)));
    outgoing.on('error', reject);
    outgoing.end();
  });
}

export async function waitUntil(
  description: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
  processes: ManagedProcess[],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const managed of processes) {
      if (managed.child.exitCode !== null || managed.child.signalCode !== null) {
        throw new Error(`${managed.name} exited while waiting for ${description}. Last lines:\n${logTail(managed)}`);
      }
    }
    if (await check().catch(() => false)) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for ${description}.\n` +
      processes.map((managed) => `--- ${managed.name} ---\n${logTail(managed)}`).join('\n'),
  );
}
