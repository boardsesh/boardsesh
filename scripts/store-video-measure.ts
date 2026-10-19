/// <reference types="node" />

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
  const child = spawn(command, args, { stdio: 'inherit' });
  const forwardInterrupt = () => child.kill('SIGINT');
  const forwardTerminate = () => child.kill('SIGTERM');
  process.once('SIGINT', forwardInterrupt);
  process.once('SIGTERM', forwardTerminate);
  const sample = () => {
    const result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
    if (result.status === 0 && child.pid) peakTreeKiB = Math.max(peakTreeKiB, treeRssKiB(result.stdout, child.pid));
    peakUsedBytes = Math.max(peakUsedBytes, totalmem() - freemem());
    if (process.platform === 'darwin') {
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
  const timer = setInterval(sample, 5000);
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
  sample();
  const minutes = (Date.now() - started) / 60_000;
  const report = {
    label,
    minutes,
    exitCode,
    peakTreeMiB: peakTreeKiB / 1024,
    peakUsedMiB: peakUsedBytes / 1024 ** 2,
    totalMiB: totalmem() / 1024 ** 2,
    simulatorTransitions,
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `| Step | Minutes | Peak process-tree RSS (MiB) | Peak runner used (MiB) | Runner RAM (MiB) | Exit |\n| --- | ---: | ---: | ---: | ---: | ---: |\n| ${label} | ${minutes.toFixed(2)} | ${report.peakTreeMiB.toFixed(0)} | ${report.peakUsedMiB.toFixed(0)} | ${report.totalMiB.toFixed(0)} | ${exitCode} |\n\nMemory sampled every 5 seconds; simulator/OS memory outside the process tree is included in runner used. See JSON for simulator boot transitions.\n`,
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
