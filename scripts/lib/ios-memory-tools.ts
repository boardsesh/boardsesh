/// <reference types="node" />
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertSameProcess, type ProcessIdentity } from './ios-memory-profile';

export function readProcessIdentity(pid: number): ProcessIdentity {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid owned app PID.');
  const startedAt = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
  const executable = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5000 }).trim();
  if (!startedAt || !executable) throw new Error('Owned app process is unavailable.');
  return { pid, startedAt, executable };
}
export interface ToolResult {
  command: string;
  args: string[];
  recorderPid: number | null;
  status: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  overflow: boolean;
  cleanupConfirmed: boolean;
  durationMs: number;
}
/** Never signal by executable name, target-app PID, simulator, or a shared process group. */
export async function runBoundedTool(command: string, args: string[], deadlineMs = 30_000): Promise<ToolResult> {
  if (!Number.isInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 30_000)
    throw new Error('Ownership tool deadline must be between 1 and 30000 milliseconds.');
  return new Promise((resolveResult) => {
    const startedAt = Date.now();
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let cleanupConfirmed = true;
    function signalOwned(signal: NodeJS.Signals) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          cleanupConfirmed = (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
      }
    }
    function finish(status: number | null) {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolveResult({
        command,
        args,
        recorderPid: child.pid ?? null,
        status,
        timedOut,
        overflow,
        cleanupConfirmed,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - startedAt,
      });
    }
    const append = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 4 * 1024 * 1024) chunks.push(chunk);
      else {
        overflow = true;
        cleanupConfirmed = false;
        signalOwned('SIGKILL');
        finish(null);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
    // Leave one second inside the total deadline for graceful recorder shutdown.
    const deadline = setTimeout(
      () => {
        timedOut = true;
        if (child.exitCode !== null || child.signalCode !== null) cleanupConfirmed = false;
        signalOwned('SIGINT');
        killTimer = setTimeout(
          () => {
            cleanupConfirmed = false;
            signalOwned('SIGKILL');
            finish(null);
          },
          Math.min(1000, deadlineMs),
        );
      },
      Math.max(0, deadlineMs - 1000),
    );
    child.on('error', (error) => append(stderr, Buffer.from(error.message)));
    child.on('close', (status) => {
      cleanupConfirmed = true;
      finish(status);
    });
  });
}

export function usefulAllocationsExport(toc: string, exported: string): boolean {
  return (
    /<table[^>]+schema=["'][^"']*allocations/i.test(toc) &&
    /<row(?:\s|>)/.test(exported) &&
    !/<error(?:\s|>)/i.test(exported)
  );
}

/** Supplemental process only: caller must keep this away from ordinary footprint comparisons. */
export async function captureOwnershipEvidence(
  identity: ProcessIdentity,
  directory: string,
  udid: string,
): Promise<unknown> {
  if (!/^[0-9a-f-]{36}$/i.test(udid)) throw new Error('Ownership inspection requires the owned simulator UDID.');
  const verify = () => assertSameProcess(identity, readProcessIdentity(identity.pid));
  verify();
  const tracePath = join(directory, 'allocations-probe.trace');
  if (existsSync(tracePath)) throw new Error('Refusing to overwrite an existing allocation trace.');
  const recorder = await runBoundedTool('xcrun', [
    'xctrace',
    'record',
    '--device',
    udid,
    '--template',
    'Allocations',
    '--attach',
    String(identity.pid),
    '--time-limit',
    '10s',
    '--output',
    tracePath,
  ]);
  writeFileSync(join(directory, 'allocations-recorder.json'), JSON.stringify(recorder, null, 2));
  verify();
  if (!recorder.cleanupConfirmed) {
    const summary = {
      allocationValid: false,
      cleanupConfirmed: false,
      fallbacks: [],
      limitations: [
        'Owned recorder exited while descendant pipes remained open; recording cleanup is unconfirmed. No further attachment attempted.',
      ],
    };
    writeFileSync(join(directory, 'ownership-validity.json'), JSON.stringify(summary, null, 2));
    return summary;
  }
  let allocationValid = false;
  if (recorder.status === 0 && !recorder.timedOut && !recorder.overflow && existsSync(tracePath)) {
    const toc = await runBoundedTool('xcrun', ['xctrace', 'export', '--input', tracePath, '--toc']);
    writeFileSync(join(directory, 'allocations-toc.json'), JSON.stringify(toc, null, 2));
    const schema = toc.stdout.match(/<table[^>]+schema=["']([^"']*allocations[^"']*)["']/i)?.[1];
    if (toc.status === 0 && !toc.timedOut && !toc.overflow && schema && /^[a-zA-Z0-9_-]+$/.test(schema)) {
      const exported = await runBoundedTool('xcrun', [
        'xctrace',
        'export',
        '--input',
        tracePath,
        '--xpath',
        `/trace-toc/run/data/table[@schema="${schema}"]`,
      ]);
      writeFileSync(join(directory, 'allocations-export.json'), JSON.stringify(exported, null, 2));
      allocationValid =
        exported.status === 0 &&
        !exported.timedOut &&
        !exported.overflow &&
        usefulAllocationsExport(toc.stdout, exported.stdout);
    }
  }
  const fallbacks = await captureOwnershipCheckpoint(identity, directory);
  const summary = {
    allocationValid,
    cleanupConfirmed: fallbacks.cleanupConfirmed,
    fallbacks: fallbacks.reports,
    limitations: [
      'Object ownership needs manual reference inspection; footprint and allocation counts alone are not a leak.',
      'Hermes heap capture was not requested; Release has no Metro inspector.',
      'Allocation stack logging requires a separate explicitly configured launch.',
      'This ownership probe is at one post-browse checkpoint; surviving-object comparison requires separate equivalent checkpoint captures.',
    ],
  };
  writeFileSync(join(directory, 'ownership-validity.json'), JSON.stringify(summary, null, 2));
  return summary;
}

/** A saved survivor graph and bounded summaries at a caller-selected equivalent checkpoint. */
export async function captureOwnershipCheckpoint(identity: ProcessIdentity, directory: string) {
  const verify = () => assertSameProcess(identity, readProcessIdentity(identity.pid));
  if (existsSync(join(directory, 'retained.memgraph')))
    throw new Error('Refusing to overwrite a surviving-object graph.');
  writeFileSync(join(directory, 'process-identity.json'), JSON.stringify(identity, null, 2));
  const fallbacks: { name: string; usable: boolean; result: ToolResult }[] = [];
  // Even completed allocation rows do not establish surviving references; preserve complementary ownership reports.
  const graphPath = join(directory, 'retained.memgraph');
  for (const name of ['leaks', 'heap', 'leaks-summary', 'vmmap'] as const) {
    verify();
    const command = name === 'leaks-summary' ? 'leaks' : name;
    const args =
      name === 'leaks'
        ? ['--outputGraph=' + graphPath, String(identity.pid)]
        : name === 'heap'
          ? ['-s', existsSync(graphPath) ? graphPath : String(identity.pid)]
          : name === 'leaks-summary'
            ? ['--list', '--noContent', graphPath]
            : ['-summary', String(identity.pid)];
    if (name === 'leaks-summary' && !existsSync(graphPath)) continue;
    const result = await runBoundedTool(command, args);
    const usable =
      result.status === 0 &&
      !result.timedOut &&
      !result.overflow &&
      (name === 'leaks' ? existsSync(join(directory, 'retained.memgraph')) : result.stdout.trim().length > 0);
    fallbacks.push({ name, usable, result });
    writeFileSync(join(directory, `${name}.json`), JSON.stringify({ usable, result }, null, 2));
    if (!result.cleanupConfirmed) break;
  }
  verify();
  return {
    cleanupConfirmed: fallbacks.every(({ result }) => result.cleanupConfirmed),
    reports: fallbacks.map(({ name, usable }) => ({ name, usable })),
  };
}

/** Explicit fallback provenance; signal zero only probes existence and never stops a process. */
export function verifyFailedAllocationProbe(
  candidate: unknown,
  udid: string,
  groupAbsent: (pid: number) => boolean = (pid) => {
    for (const target of [pid, -pid]) {
      try {
        process.kill(target, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
      }
    }
    return true;
  },
) {
  const probe =
    candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>)
      : null;
  const args = probe?.args;
  const argument = (flag: string) => {
    const index = Array.isArray(args) ? args.indexOf(flag) : -1;
    return index >= 0 ? (args as unknown[])[index + 1] : undefined;
  };
  if (
    !/^[0-9a-f-]{36}$/i.test(udid) ||
    probe?.command !== 'xcrun' ||
    !Array.isArray(args) ||
    args[0] !== 'xctrace' ||
    args[1] !== 'record' ||
    !args.every((item) => typeof item === 'string') ||
    argument('--device') !== udid ||
    argument('--template') !== 'Allocations' ||
    argument('--time-limit') !== '10s' ||
    !/^[1-9][0-9]*$/.test(String(argument('--attach'))) ||
    typeof argument('--output') !== 'string' ||
    !(argument('--output') as string).trim() ||
    (argument('--output') as string).startsWith('--') ||
    typeof probe.recorderPid !== 'number' ||
    !Number.isInteger(probe.recorderPid) ||
    probe.recorderPid <= 0 ||
    typeof probe.durationMs !== 'number' ||
    !Number.isFinite(probe.durationMs) ||
    probe.durationMs <= 0 ||
    probe.durationMs > 31000 ||
    !((typeof probe.status === 'number' && probe.status !== 0) || (probe.status === null && probe.timedOut === true))
  )
    throw new Error(
      'Graph fallback requires a recorded failed bounded Allocations probe on this explicitly owned simulator.',
    );
  if (!groupAbsent(probe.recorderPid))
    throw new Error('Prior Allocations recorder group absence is not confirmed; refusing fallback attachment.');
  return {
    recorderPid: probe.recorderPid,
    recorderAbsent: true,
    recorderGroupAbsent: true,
    observedAt: new Date().toISOString(),
    method: 'read-only recorder PID and process group existence probes; ESRCH establishes absence for both',
    allocationValid: false,
  };
}
