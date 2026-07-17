/// <reference types="node" />

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import {
  criticalChildProcessSpawnOptions,
  CriticalChildProcessGroup,
  type CriticalChildProcess,
  type CriticalChildTermination,
} from '../lib/dev-child-process-lifecycle';

type GrandchildReadyMessage = {
  pid: number;
  port: number;
};

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() >= deadline) throw new Error(`Process ${pid} survived managed shutdown`);
    await delay(25);
  }
}

function isPortReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function waitForGrandchildReady(childProcess: ChildProcess): Promise<GrandchildReadyMessage> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeoutId = setTimeout(() => reject(new Error('Timed out waiting for managed grandchild')), 5_000);
    childProcess.stdout?.on('data', (outputChunk: Buffer) => {
      output += outputChunk.toString();
      const newlineIndex = output.indexOf('\n');
      if (newlineIndex === -1) return;

      clearTimeout(timeoutId);
      try {
        const message: unknown = JSON.parse(output.slice(0, newlineIndex));
        if (
          typeof message !== 'object' ||
          message === null ||
          !('pid' in message) ||
          typeof message.pid !== 'number' ||
          !('port' in message) ||
          typeof message.port !== 'number'
        ) {
          reject(new Error('Managed grandchild returned an invalid ready message'));
          return;
        }
        resolve({ pid: message.pid, port: message.port });
      } catch (error) {
        reject(error);
      }
    });
    childProcess.once('error', reject);
  });
}

function waitForChildExit(childProcess: ChildProcess): Promise<void> {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error('Timed out waiting for managed wrapper exit')), 5_000);
    childProcess.once('exit', () => {
      clearTimeout(timeoutId);
      resolve();
    });
  });
}

function forceCleanupProcessTree(childProcess: ChildProcess): void {
  if (childProcess.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(childProcess.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-childProcess.pid, 'SIGKILL');
  } catch {
    childProcess.kill('SIGKILL');
  }
}

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  readonly killSignals: NodeJS.Signals[] = [];
  signalCode: NodeJS.Signals | null = null;
  terminateOnSigterm = false;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    if (signal === 'SIGTERM' && this.terminateOnSigterm) {
      this.signalCode = signal;
    }
    return true;
  }

  asCriticalChild(): CriticalChildProcess {
    return this as unknown as CriticalChildProcess;
  }
}

function createGroup(
  overrides: {
    onUnexpectedTermination?: (termination: CriticalChildTermination) => void;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  const onUnexpectedTermination = overrides.onUnexpectedTermination ?? vi.fn();
  const sleep = overrides.sleep ?? vi.fn(async () => undefined);
  const group = new CriticalChildProcessGroup({
    onUnexpectedTermination,
    gracePeriodMs: 25,
    sleep,
  });

  return { group, onUnexpectedTermination, sleep };
}

describe('CriticalChildProcessGroup', () => {
  it('treats a clean child exit as fatal and reports only the first unexpected termination', () => {
    const { group, onUnexpectedTermination } = createGroup();
    const backend = new FakeChildProcess();
    const web = new FakeChildProcess();
    group.register('Backend', backend.asCriticalChild());
    group.register('Web', web.asCriticalChild());

    backend.emit('exit', 0, null);
    web.emit('exit', 1, null);

    expect(onUnexpectedTermination).toHaveBeenCalledOnce();
    expect(onUnexpectedTermination).toHaveBeenCalledWith({
      type: 'exit',
      name: 'Backend',
      code: 0,
      signal: null,
    });
    expect(group.isShuttingDown).toBe(true);
    expect(group.shutdownExitCode).toBe(1);
  });

  it('treats a child process error as fatal', () => {
    const { group, onUnexpectedTermination } = createGroup();
    const expoWeb = new FakeChildProcess();
    group.register('Expo web', expoWeb.asCriticalChild());

    const spawnError = new Error('spawn failed');
    expoWeb.emit('error', spawnError);

    expect(onUnexpectedTermination).toHaveBeenCalledWith({
      type: 'error',
      name: 'Expo web',
      error: spawnError,
    });
  });

  it('ignores child exits after intentional shutdown begins', () => {
    const { group, onUnexpectedTermination } = createGroup();
    const backend = new FakeChildProcess();
    group.register('Backend', backend.asCriticalChild());

    group.beginShutdown();
    backend.emit('exit', null, 'SIGTERM');

    expect(onUnexpectedTermination).not.toHaveBeenCalled();
  });

  it('closes the startup barrier and preserves the initiating exit status', () => {
    const { group } = createGroup();

    expect(group.beginShutdown(0)).toBe(true);
    expect(group.isShuttingDown).toBe(true);
    expect(group.shutdownExitCode).toBe(0);

    expect(group.beginShutdown(1)).toBe(false);
    expect(group.shutdownExitCode).toBe(0);
  });

  it('rejects and terminates a child registered after the startup barrier closes', () => {
    const { group, onUnexpectedTermination } = createGroup();
    const lateWeb = new FakeChildProcess();
    group.beginShutdown(0);

    expect(group.register('Web', lateWeb.asCriticalChild())).toBe(false);

    expect(lateWeb.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    lateWeb.emit('exit', null, 'SIGKILL');
    expect(onUnexpectedTermination).not.toHaveBeenCalled();
    expect(group.shutdownExitCode).toBe(0);
  });

  it('terminates every running child and waits for the grace period', async () => {
    const sleep = vi.fn(async () => undefined);
    const { group } = createGroup({ sleep });
    const backend = new FakeChildProcess();
    const expoWeb = new FakeChildProcess();
    backend.terminateOnSigterm = true;
    expoWeb.terminateOnSigterm = true;
    group.register('Backend', backend.asCriticalChild());
    group.register('Expo web', expoWeb.asCriticalChild());

    await group.terminate();

    expect(backend.killSignals).toEqual(['SIGTERM']);
    expect(expoWeb.killSignals).toEqual(['SIGTERM']);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it('uses actual exit state for SIGKILL fallback even when kill() marked the child killed', async () => {
    const { group } = createGroup();
    const web = new FakeChildProcess();
    group.register('Web', web.asCriticalChild());

    await group.terminate();

    expect(web.killed).toBe(true);
    expect(web.exitCode).toBeNull();
    expect(web.signalCode).toBeNull();
    expect(web.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not signal children that already exited', async () => {
    const { group, sleep } = createGroup();
    const backend = new FakeChildProcess();
    backend.exitCode = 1;
    group.register('Backend', backend.asCriticalChild());

    await group.terminate();

    expect(backend.killSignals).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('terminates a listening grandchild whose wrapper exited before shutdown starts', async () => {
    const grandchildSource = `
        const { createServer } = require('node:net');
        const server = createServer();
        process.on('SIGTERM', () => {});
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          process.stdout.write(JSON.stringify({ pid: process.pid, port: address.port }) + '\\n');
        });
      `;
    const wrapperSource = `
        const { spawn } = require('node:child_process');
        const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], {
          stdio: ['ignore', 'inherit', 'inherit'],
        });
        grandchild.unref();
      `;
    const managedWrapper = spawn(process.execPath, ['-e', wrapperSource], {
      ...criticalChildProcessSpawnOptions,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const group = new CriticalChildProcessGroup({
      gracePeriodMs: 50,
      onUnexpectedTermination: vi.fn(),
    });

    try {
      expect(group.register('Integration wrapper', managedWrapper)).toBe(true);
      const grandchild = await waitForGrandchildReady(managedWrapper);
      await waitForChildExit(managedWrapper);
      expect(managedWrapper.exitCode).toBe(0);
      expect(processExists(grandchild.pid)).toBe(true);
      expect(await isPortReachable(grandchild.port)).toBe(true);

      await group.terminate();
      await waitForProcessExit(grandchild.pid);

      expect(await isPortReachable(grandchild.port)).toBe(false);
    } finally {
      forceCleanupProcessTree(managedWrapper);
    }
  }, 10_000);
});
