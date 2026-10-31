import type { ChildProcess } from 'node:child_process';
import { basename } from 'node:path';

export type CommandOutcome = {
  status: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnErrno: string | null;
  settledBy: 'error' | 'exit' | 'close' | 'sync' | 'caught';
};
const errnoNames = new Set(['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'EAGAIN', 'ENOMEM', 'ECANCELED']);
export function observedErrno(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' && errnoNames.has(error.code) ? error.code : 'unrecognized_errno';
}
/** Metadata only: the first child settlement wins even if error/exit/close all arrive. */
export function commandOutcome(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  settledBy: CommandOutcome['settledBy'],
  error?: unknown,
): CommandOutcome {
  return { status: exitCode ?? -1, exitCode, signal, spawnErrno: observedErrno(error), settledBy };
}
export function waitForCommandSettlement(child: Pick<ChildProcess, 'once'>): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: CommandOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    child.once('error', (error) => finish(commandOutcome(null, null, 'error', error)));
    child.once('exit', (code, signal) => finish(commandOutcome(code, signal, 'exit')));
    child.once('close', (code, signal) => finish(commandOutcome(code, signal, 'close')));
  });
}
export type AbortSource = 'observation_deadline' | 'SIGINT' | 'SIGTERM' | 'critical_server_exit';
export type AbortReceipt = {
  source: AbortSource;
  observedAt: string;
  server: 'owned-observation-metro' | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnErrno: string | null;
};
export function firstAbortRecorder() {
  let first: Readonly<AbortReceipt> | null = null;
  return {
    record(
      source: AbortSource,
      child?: { name: string; code?: number | null; signal?: NodeJS.Signals | null; error?: unknown },
    ) {
      first ??= Object.freeze({
        source,
        observedAt: new Date().toISOString(),
        server: child?.name === 'owned-observation-metro' ? child.name : null,
        exitCode: child?.code ?? null,
        signal: child?.signal ?? null,
        spawnErrno: observedErrno(child?.error),
      });
      return first;
    },
    current: () => first,
  };
}
export type DeadlineFlags = {
  timeoutFired: boolean;
  hardTimeoutFired: boolean;
  stopEscalationFired: boolean;
};
export const deadlineFlags = (): DeadlineFlags => ({
  timeoutFired: false,
  hardTimeoutFired: false,
  stopEscalationFired: false,
});
function nativeReason(stderr: string): { domain: string; code: number } | null {
  const match = stderr.match(
    /(?:domain=|Error Domain=)(NSPOSIXErrorDomain|NSCocoaErrorDomain|com\.apple\.CoreSimulator\.SimError|FBSOpenApplicationServiceErrorDomain|RBSRequestErrorDomain)[, ]+(?:code|Code)=(-?\d{1,6})\b/,
  );
  return match ? { domain: match[1], code: Number(match[2]) } : null;
}
export type PassiveMetroState = { pid: number | null; exitCode: number | null; signal: NodeJS.Signals | null } | null;
export function commandReceipt(input: {
  label: string;
  executable: string;
  operation: string | null;
  ownedUdid: string | null;
  startedAt: string;
  completedAt: string;
  elapsedSeconds: number;
  timeoutMs: number;
  outcome: CommandOutcome;
  flags: DeadlineFlags;
  abort: Readonly<AbortReceipt> | null;
  controllerAborted: boolean;
  stderr: string;
  stdout: string;
  metro: PassiveMetroState;
}) {
  const executable = basename(input.executable);
  const launchedPid =
    input.outcome.status === 0 && /^launch-[12]$/.test(input.label)
      ? input.stdout.match(/^com\.boardsesh\.app:\s*([1-9]\d{0,8})\s*$/m)?.[1]
      : undefined;
  return Object.freeze({
    label: /^[a-z][a-z0-9-]{0,79}$/.test(input.label) ? input.label : 'unrecognized-operation',
    executable: ['xcrun', 'git', 'plutil', 'maestro', 'node'].includes(executable) ? executable : 'other',
    operation:
      input.operation &&
      ['launch', 'terminate', 'shutdown', 'create', 'boot', 'bootstatus', 'install', 'list', 'io'].includes(
        input.operation,
      )
        ? input.operation
        : null,
    ownedUdid:
      input.ownedUdid && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.ownedUdid)
        ? input.ownedUdid
        : null,
    appBundle: 'com.boardsesh.app',
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    elapsedSeconds: input.elapsedSeconds,
    timeoutMs: input.timeoutMs,
    ...input.outcome,
    ...input.flags,
    controllerAborted: input.controllerAborted,
    firstAbort: input.abort,
    nativeReason: nativeReason(input.stderr),
    launchedAppPid: launchedPid ? Number(launchedPid) : null,
    passiveMetroChild: input.metro,
  });
}
export type CommandReceipt = ReturnType<typeof commandReceipt>;
export function firstFailureRecorder() {
  let first: Readonly<{ code: string; command: CommandReceipt | null }> | null = null;
  return {
    freeze(code: string, command?: CommandReceipt) {
      first ??= Object.freeze({
        code: /^[a-zA-Z0-9_-]{1,120}$/.test(code) ? code : 'unexpected_error_redacted',
        command: command ?? null,
      });
      return first;
    },
    current: () => first,
  };
}
