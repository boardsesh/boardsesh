/// <reference types="node" />

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { freemem, totalmem } from 'node:os';
import { pathToFileURL } from 'node:url';

/** Sum resident memory for a process and its current descendants (ps reports KiB). */
export function treeRssKiB(processes: string, rootPid: number): number {
  const rows = processes
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const descendants = new Set([rootPid]);
  let previousSize = 0;
  while (previousSize !== descendants.size) {
    previousSize = descendants.size;
    for (const [pid, parent] of rows) if (descendants.has(parent)) descendants.add(pid);
  }
  return rows.reduce((sum, [pid, , rss]) => sum + (descendants.has(pid) && Number.isFinite(rss) ? rss : 0), 0);
}

/** Reclaimable file cache counts as non-free RAM; collect the other evidence too. */
export function parseDarwinVmStat(output: string) {
  const pageSizeBytes = Number(output.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isFinite(pageSizeBytes) || pageSizeBytes <= 0) return null;
  const counters = new Map(
    [...output.matchAll(/^([^:\n]+):\s*(\d+)\.\s*$/gm)].map((match) => [match[1].trim(), Number(match[2])]),
  );
  const mebibytes = (counter: string): number | null => {
    const pages = counters.get(counter);
    return pages === undefined ? null : (pages * pageSizeBytes) / 1024 ** 2;
  };
  return {
    pageSizeBytes,
    freeMiB: mebibytes('Pages free'),
    activeMiB: mebibytes('Pages active'),
    inactiveMiB: mebibytes('Pages inactive'),
    speculativeMiB: mebibytes('Pages speculative'),
    wiredMiB: mebibytes('Pages wired down'),
    purgeableMiB: mebibytes('Pages purgeable'),
    fileBackedMiB: mebibytes('File-backed pages'),
    anonymousMiB: mebibytes('Anonymous pages'),
    compressedMiB: mebibytes('Pages occupied by compressor'),
    compressorUncompressedMiB: mebibytes('Pages stored in compressor'),
  };
}

export function parseDarwinSwapUsage(output: string) {
  const mebibytes = (counter: string): number | null => {
    const match = output.match(new RegExp(`\\b${counter}\\s*=\\s*(\\d+(?:\\.\\d+)?)([KMGT])\\b`));
    if (!match) return null;
    const factors: Record<string, number> = { K: 1 / 1024, M: 1, G: 1024, T: 1024 ** 2 };
    return Number(match[1]) * factors[match[2]];
  };
  const totalMiB = mebibytes('total');
  const usedMiB = mebibytes('used');
  const freeMiB = mebibytes('free');
  return totalMiB === null || usedMiB === null || freeMiB === null ? null : { totalMiB, usedMiB, freeMiB };
}

export function parseDarwinMemoryPressure(output: string): number | null {
  const match = output.match(/System-wide memory free percentage:\s*(\d+)%/);
  return match && Number(match[1]) <= 100 ? Number(match[1]) : null;
}

/** Executable names only: process arguments can contain credentials. */
export function topResidentProcesses(output: string) {
  return output
    .split('\n')
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/);
      return match
        ? [
            {
              pid: Number(match[1]),
              parentPid: Number(match[2]),
              rssMiB: Number(match[3]) / 1024,
              executable: basename(match[4]),
            },
          ]
        : [];
    })
    .sort((first, second) => second.rssMiB - first.rssMiB)
    .slice(0, 5);
}

/** Pressure tools are separate from the cheap five-second RSS sample. */
export function memoryDiagnosticSampleDue(nowMs: number, previousMs: number | null): boolean {
  return previousMs === null || nowMs - previousMs >= 30_000;
}

function sampleDarwinMemory(processes: string, seconds: number, nonFreeMiB: number) {
  const options = { encoding: 'utf8' as const, timeout: 1000 };
  const vmStat = spawnSync('vm_stat', [], options);
  const swapUsage = spawnSync('sysctl', ['vm.swapusage'], options);
  // -Q is query-only: never run memory_pressure's allocation/stress modes.
  const pressure = spawnSync('memory_pressure', ['-Q'], options);
  return {
    seconds,
    nonFreeMiB,
    vm: vmStat.status === 0 ? parseDarwinVmStat(vmStat.stdout) : null,
    swap: swapUsage.status === 0 ? parseDarwinSwapUsage(swapUsage.stdout) : null,
    pressureFreePercent: pressure.status === 0 ? parseDarwinMemoryPressure(pressure.stdout) : null,
    topProcesses: topResidentProcesses(processes),
    sensorExitCodes: { vmStat: vmStat.status, swapUsage: swapUsage.status, memoryPressure: pressure.status },
  };
}

export async function measure(argv: string[]): Promise<number> {
  const [label, output, separator, command, ...args] = argv;
  if (!label || !output || separator !== '--' || !command) {
    throw new Error('Usage: store-video-measure.ts LABEL REPORT.json -- COMMAND [ARGS...]');
  }
  mkdirSync(dirname(output), { recursive: true });
  const started = Date.now();
  let peakTreeKiB = 0;
  let peakUsedBytes = 0;
  let simulatorState = '';
  const simulatorTransitions: { seconds: number; booted: string[] }[] = [];
  const memoryDiagnostics: ReturnType<typeof sampleDarwinMemory>[] = [];
  let previousMemoryDiagnosticMs: number | null = null;
  const child = spawn(command, args, { stdio: 'inherit' });
  const forwardInterrupt = () => child.kill('SIGINT');
  const forwardTerminate = () => child.kill('SIGTERM');
  process.once('SIGINT', forwardInterrupt);
  process.once('SIGTERM', forwardTerminate);
  const sample = (final = false) => {
    const result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' });
    if (result.status === 0 && child.pid) peakTreeKiB = Math.max(peakTreeKiB, treeRssKiB(result.stdout, child.pid));
    const nonFreeBytes = totalmem() - freemem();
    peakUsedBytes = Math.max(peakUsedBytes, nonFreeBytes);
    if (process.platform === 'darwin') {
      const nowMs = Date.now();
      if (final || memoryDiagnosticSampleDue(nowMs, previousMemoryDiagnosticMs)) {
        previousMemoryDiagnosticMs = nowMs;
        memoryDiagnostics.push(
          sampleDarwinMemory(
            result.status === 0 ? result.stdout : '',
            (nowMs - started) / 1000,
            nonFreeBytes / 1024 ** 2,
          ),
        );
      }
      const sims = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'], { encoding: 'utf8' });
      if (sims.status === 0) {
        const listing = JSON.parse(sims.stdout) as { devices: Record<string, { name: string; udid: string }[]> };
        const booted = Object.values(listing.devices)
          .flat()
          .map((device) => `${device.name} (${device.udid})`)
          .sort();
        const state = JSON.stringify(booted);
        if (state !== simulatorState) {
          simulatorState = state;
          simulatorTransitions.push({ seconds: (Date.now() - started) / 1000, booted });
          console.log(`[store-video-measure] ${label}: booted simulators = ${state}`);
        }
      }
    }
  };
  const timer = setInterval(() => sample(), 5000);
  sample();
  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    clearInterval(timer);
    process.removeListener('SIGINT', forwardInterrupt);
    process.removeListener('SIGTERM', forwardTerminate);
  }
  sample(true);
  const minutes = (Date.now() - started) / 60_000;
  const report = {
    label,
    minutes,
    exitCode,
    peakTreeMiB: peakTreeKiB / 1024,
    peakUsedMiB: peakUsedBytes / 1024 ** 2,
    totalMiB: totalmem() / 1024 ** 2,
    simulatorTransitions,
    memoryDiagnostics,
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `| Step | Minutes | Peak process-tree RSS (MiB) | Peak runner non-free (MiB) | Runner RAM (MiB) | Exit |\n| --- | ---: | ---: | ---: | ---: | ---: |\n| ${label} | ${minutes.toFixed(2)} | ${report.peakTreeMiB.toFixed(0)} | ${report.peakUsedMiB.toFixed(0)} | ${report.totalMiB.toFixed(0)} | ${exitCode} |\n\nRSS/non-free memory sampled every 5 seconds. Non-free includes reclaimable cache and does not establish memory pressure. macOS pressure, VM counters, swap and top-five RSS snapshots are sampled every 30 seconds and at exit (unsupported sensors are null). See JSON for these samples and simulator boot transitions.\n`,
    );
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  measure(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
