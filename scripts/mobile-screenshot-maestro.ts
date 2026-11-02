/// <reference types="node" />

import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CriticalChildProcessGroup, criticalChildProcessSpawnOptions } from './lib/dev-child-process-lifecycle';

export const CPP_MAESTRO_TIMEOUT_MS = 30 * 60 * 1000;
export const IOS_MAESTRO_TIMEOUT_MS = 45 * 60 * 1000;
const MAX_MAESTRO_TIMEOUT_MS = 60 * 60 * 1000;

/** Only the wrapper's leading option is consumed; Maestro receives the rest verbatim. */
export function parseScreenshotMaestroArguments(args: string[]): { timeoutMs: number; maestroArgs: string[] } {
  if (args[0] !== '--capture-timeout-ms') return { timeoutMs: CPP_MAESTRO_TIMEOUT_MS, maestroArgs: args };
  const timeout = args[1] ?? '';
  const timeoutMs = Number(timeout);
  if (!/^[1-9]\d*$/.test(timeout) || !Number.isSafeInteger(timeoutMs) || timeoutMs > MAX_MAESTRO_TIMEOUT_MS) {
    throw new Error('Maestro capture timeout must be an integer from 1 to 3600000 milliseconds');
  }
  return { timeoutMs, maestroArgs: args.slice(2) };
}

interface MaestroProcessOptions {
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  gracePeriodMs?: number;
  onStderr?: (chunk: Buffer) => void;
  onStdout?: (chunk: Buffer) => void;
  onSpawn?: (child: ChildProcess) => void;
}

/** Run separately: the screenshot orchestrator's synchronous calls block timers. */
export async function runScreenshotMaestro(args: string[], options: MaestroProcessOptions = {}): Promise<number> {
  let settle: (status: number) => void = () => {};
  const result = new Promise<number>((resolveStatus) => {
    settle = resolveStatus;
  });
  let failed = false;
  const fail = (reason: string) => {
    if (failed) return;
    failed = true;
    console.error(`[mobile:screenshots] ${reason}; stopping this Maestro attempt.`);
    settle(1);
  };
  const children = new CriticalChildProcessGroup({
    gracePeriodMs: options.gracePeriodMs,
    onUnexpectedTermination: (termination) => {
      if (termination.type === 'error') fail('Maestro could not start');
      else settle(termination.code ?? 1);
    },
  });
  const maestro = spawn(options.command ?? 'maestro', args, {
    ...criticalChildProcessSpawnOptions,
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['inherit', options.onStdout ? 'pipe' : 'inherit', 'pipe'],
  });
  children.register('Maestro', maestro);
  options.onSpawn?.(maestro);
  maestro.stdout?.on('data', (chunk: Buffer) => options.onStdout?.(chunk));

  // The JVM can retain worker threads after its main thread crashes. Match only
  // its exact stderr exception prefix, including prefixes split across chunks.
  let stderrTail = '';
  maestro.stderr?.on('data', (chunk: Buffer) => {
    if (options.onStderr) options.onStderr(chunk);
    else process.stderr.write(chunk);
    const combined = stderrTail + chunk.toString('utf8');
    if (/(?:^|\r?\n)Exception in thread "main"(?:\s|$)/.test(combined)) {
      fail('Maestro main thread crashed');
    }
    // A truncated line must not gain a synthetic line-start exception prefix.
    stderrTail = combined.length > 256 ? ` ${combined.slice(-256)}` : combined;
  });
  const deadline = setTimeout(
    () => fail(`Maestro exceeded its capture limit (${(options.timeoutMs ?? CPP_MAESTRO_TIMEOUT_MS) / 1000}s)`),
    options.timeoutMs ?? CPP_MAESTRO_TIMEOUT_MS,
  );
  const interrupt = () => fail('Maestro capture was interrupted');
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);

  try {
    const status = await result;
    // Kill only our detached group, including descendants that retained stderr
    // after the launcher exited. SIGKILL follows the bounded SIGTERM grace.
    await children.terminate();
    return failed ? 1 : status;
  } finally {
    clearTimeout(deadline);
    process.off('SIGTERM', interrupt);
    process.off('SIGINT', interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void Promise.resolve()
    .then(() => {
      const { timeoutMs, maestroArgs } = parseScreenshotMaestroArguments(process.argv.slice(2));
      return runScreenshotMaestro(maestroArgs, { timeoutMs });
    })
    .then((status) => process.exit(status))
    .catch(() => {
      console.error('[mobile:screenshots] Maestro supervisor failed.');
      process.exit(1);
    });
}
