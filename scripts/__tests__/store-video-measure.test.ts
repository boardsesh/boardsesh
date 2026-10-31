import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  treeRssKiB,
  parseDarwinVmStat,
  parseDarwinSwapUsage,
  parseDarwinMemoryPressure,
  topResidentProcesses,
  memoryDiagnosticSampleDue,
} from '../store-video-measure';

describe('store video memory measurement', () => {
  it('counts descendants regardless of ordering and excludes unrelated runner processes', () => {
    expect(treeRssKiB('13 12 300\n90 1 99999\n12 11 200\n11 1 100', 11)).toBe(600);
  });
  it('tolerates an exited process and empty snapshots', () => {
    expect(treeRssKiB('', 42)).toBe(0);
    expect(treeRssKiB('4 1 500', 42)).toBe(0);
  });

  it('keeps RSS ancestry accounting when the snapshot includes executable names', () => {
    expect(
      treeRssKiB(
        '13 12 300 /usr/bin/java\n90 1 99999 /usr/bin/other\n12 11 200 /usr/bin/node\n11 1 100 /usr/bin/vp',
        11,
      ),
    ).toBe(600);
  });

  it('separates file cache, anonymous, wired and compressed memory using the host page size', () => {
    const snapshot = parseDarwinVmStat(`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                  64.
Pages active:                               128.
Pages inactive:                             256.
Pages speculative:                          128.
Pages wired down:                           512.
Pages purgeable:                             64.
File-backed pages:                          768.
Anonymous pages:                           1024.
Pages stored in compressor:                  96.
Pages occupied by compressor:                32.
`);
    expect(snapshot).toEqual({
      pageSizeBytes: 16384,
      freeMiB: 1,
      activeMiB: 2,
      inactiveMiB: 4,
      speculativeMiB: 2,
      wiredMiB: 8,
      purgeableMiB: 1,
      fileBackedMiB: 12,
      anonymousMiB: 16,
      compressedMiB: 0.5,
      compressorUncompressedMiB: 1.5,
    });
    expect(
      parseDarwinVmStat('Mach Virtual Memory Statistics: (page size of 4096 bytes)\nAnonymous pages: 512.'),
    ).toMatchObject({ anonymousMiB: 2, compressedMiB: null });
  });

  it('reports unsupported or missing VM, swap and pressure sensors as null', () => {
    expect(parseDarwinVmStat('unsupported')).toBeNull();
    expect(parseDarwinSwapUsage('permission denied')).toBeNull();
    expect(parseDarwinMemoryPressure('unsupported')).toBeNull();
    expect(parseDarwinMemoryPressure('System-wide memory free percentage: 101%')).toBeNull();
  });

  it('reads swap units and query-only memory pressure independently from free RAM', () => {
    expect(parseDarwinSwapUsage('vm.swapusage: total = 2048.00M used = 1.25G free = 768.00M (encrypted)')).toEqual({
      totalMiB: 2048,
      usedMiB: 1280,
      freeMiB: 768,
    });
    expect(parseDarwinSwapUsage('vm.swapusage: total = 0.00M used = 0.00M free = 0.00M (encrypted)')).toEqual({
      totalMiB: 0,
      usedMiB: 0,
      freeMiB: 0,
    });
    expect(parseDarwinMemoryPressure('The system has 7516192768 bytes.\nSystem-wide memory free percentage: 76%')).toBe(
      76,
    );
  });

  it('keeps only the five largest resident executables and strips their paths', () => {
    const processes = topResidentProcesses(`10 1 2048 /usr/bin/node
11 1 7168 /Applications/Boardsesh.app/Boardsesh
12 1 1024 /usr/bin/small
13 1 6144 /System/Library/Simulator
14 1 3072 /usr/bin/java
15 1 5120 /usr/bin/Metro Worker
16 1 4096 /usr/bin/other
malformed`);
    expect(processes.map((process) => process.executable)).toEqual([
      'Boardsesh',
      'Simulator',
      'Metro Worker',
      'other',
      'java',
    ]);
    expect(processes[0]).toEqual({ pid: 11, parentPid: 1, rssMiB: 7, executable: 'Boardsesh' });
    expect(topResidentProcesses('')).toEqual([]);
  });

  it('runs expensive sensors every thirty seconds rather than on each RSS tick', () => {
    let previous: number | null = null;
    const times: number[] = [];
    for (let now = 0; now <= 60_000; now += 5000) {
      if (memoryDiagnosticSampleDue(now, previous)) {
        times.push(now);
        previous = now;
      }
    }
    expect(times).toEqual([0, 30_000, 60_000]);
  });

  it('bounds RSS and simulator-state sampling so metrics cannot hang the capture', () => {
    const source = readFileSync('scripts/store-video-measure.ts', 'utf8');
    const rssOptions = source.match(/spawnSync\('ps',\s*\[[^\]]+\],\s*\{([^}]+)\}/)?.[1];
    const simulatorOptions = source.match(/spawnSync\('xcrun',\s*\[[^\]]+\],\s*\{([^}]+)\}/)?.[1];
    for (const options of [rssOptions, simulatorOptions]) {
      expect(options).toContain('timeout: 2000');
      expect(options).toContain("killSignal: 'SIGKILL'");
    }
  });
});
