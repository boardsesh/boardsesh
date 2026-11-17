import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  belongsToSimulator,
  MAX_SAMPLES,
  SAMPLE_TIMEOUT_MS,
  WORKER_TIMEOUT_MS,
  parseProcessRows,
  sampleArgs,
  sampleTargets,
  rememberMarkers,
  sampleOwnedMarker,
  command,
  type MarkerProcess,
} from '../duo-startup-diagnostics';

interface Workflow {
  jobs: Record<
    string,
    { if: string; steps: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, unknown> }> }
  >;
}
const workflow = parse(readFileSync('.github/workflows/duo-startup-diagnostics.yml', 'utf8')) as Workflow;
const recovery = parse(readFileSync('.github/workflows/mobile-screenshot-cache-recovery.yml', 'utf8')) as Workflow;

describe('Duo startup observation', () => {
  it('samples an owned marker despite failed global discovery and preserves its original observation age', () => {
    const now = Date.parse('2026-11-17T10:06:30Z');
    const markers = new Map<number, MarkerProcess>();
    rememberMarkers('entry process=SpringBoard pid=8025\nentry process=unrelated pid=44', now - 30_000, markers);
    rememberMarkers('entry process=SpringBoard pid=8025', now, markers);
    expect(markers.size).toBe(1);
    const calls: string[] = [];
    const run: typeof command = (program, args, timeoutMs) => {
      calls.push(`${program} ${args.join(' ')}`);
      return {
        status: 0,
        rawStatus: 0,
        timeoutMs,
        elapsedMs: 1,
        errorCode: null,
        signal: null,
        stderr: '',
        stdout: args.includes('lstart=,comm=')
          ? 'Tue Nov 17 10:05:38 2026 /System/SpringBoard'
          : args.includes('eww')
            ? 'SECRET=never-retain SIMULATOR_UDID=C898E3E4-5033-4085-B886-963EE2D0C478'
            : '',
      };
    };
    expect(sampleTargets(parseProcessRows(''), 10, new Set(), new Set())).toEqual([]);
    const result = sampleOwnedMarker(
      markers.get(8025)!,
      'C898E3E4-5033-4085-B886-963EE2D0C478',
      now,
      '/tmp/sample',
      run,
    );
    expect(result.sampled).toBe(true);
    expect(calls.at(-1)).toBe('/usr/bin/sample 8025 1 10 -file /tmp/sample');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('rejects recycled marker PIDs and foreign simulator ownership before sampling', () => {
    const now = Date.parse('2026-11-17T10:06:30Z');
    const marker: MarkerProcess = { pid: 8025, name: 'SpringBoard', observedAt: now - 30_000 };
    for (const identity of [
      'Tue Nov 17 10:06:15 2026 /System/SpringBoard',
      'Tue Nov 17 10:05:38 2026 /System/Other',
      'Tue Nov 17 10:05:38 2026 /System/SpringBoard',
    ]) {
      const run: typeof command = (program, args, timeoutMs) => {
        expect(program).not.toBe('/usr/bin/sample');
        return {
          status: 0,
          rawStatus: 0,
          signal: null,
          errorCode: null,
          elapsedMs: 1,
          timeoutMs,
          stderr: '',
          stdout: args.includes('eww') ? 'SIMULATOR_UDID=another-device' : identity,
        };
      };
      expect(sampleOwnedMarker(marker, 'C898E3E4-5033-4085-B886-963EE2D0C478', now, '/tmp/sample', run).sampled).toBe(
        false,
      );
    }
  });
  it('retains actual timeout, signal, raw status and elapsed evidence', () => {
    const result = command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 50);
    expect(result.status).toBe(1);
    expect(result.rawStatus).toBeNull();
    expect(result.signal).toBe('SIGKILL');
    expect(result.errorCode).toBe('ETIMEDOUT');
    expect(result.timeoutMs).toBe(50);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(40);
  });
  it('samples only owned command descendants and explicitly identified SpringBoard processes', () => {
    const rows = parseProcessRows(
      '10 1 node\n11 10 /usr/bin/xcrun\n12 11 /path/simctl\n13 12 /bin/launchctl\n14 1 /SpringBoard\n15 1 /SpringBoard\n16 1 /bin/launchctl\n17 10 /usr/bin/unrelated',
    );
    expect(
      sampleTargets(rows.reverse(), 10, new Set([14]), new Set())
        .map((row) => row.pid)
        .sort((left, right) => left - right),
    ).toEqual([11, 12, 13, 14]);
  });
  it('never interprets process arguments or environment text as a target', () => {
    expect(
      sampleTargets(
        parseProcessRows('19 10 /usr/bin/node --token secret\n20 1 /bin/launchctl'),
        10,
        new Set(),
        new Set(),
      ),
    ).toEqual([]);
    expect(parseProcessRows('PID PPID COMMAND\ninvalid')).toEqual([]);
  });
  it('identifies simulator-owned launchctl without persisting its environment', () => {
    const udid = 'C898E3E4-5033-4085-B886-963EE2D0C478';
    expect(belongsToSimulator(`launchctl SECRET=not-recorded SIMULATOR_UDID=${udid} PATH=/bin`, udid)).toBe(true);
    expect(belongsToSimulator(`OTHER_SIMULATOR_UDID=${udid}`, udid)).toBe(false);
    expect(belongsToSimulator(`SIMULATOR_UDID=${udid}extra`, udid)).toBe(false);
    expect(belongsToSimulator(`SIMULATOR_UDID=${udid}`, 'invalid')).toBe(false);
    expect(
      sampleTargets(parseProcessRows('20 1 /bin/launchctl'), 10, new Set(), new Set([20])).map((row) => row.pid),
    ).toEqual([20]);
  });
  it('bounds native samples and the whole observer independently of historical deadlines', () => {
    expect(sampleArgs(123, '/tmp/sample.txt')).toEqual(['123', '1', '10', '-file', '/tmp/sample.txt']);
    for (const pid of [0, 1, -10, 1.5, NaN]) expect(() => sampleArgs(pid, '/tmp/sample')).toThrow();
    expect(SAMPLE_TIMEOUT_MS).toBe(5_000);
    expect(MAX_SAMPLES).toBe(24);
    expect(WORKER_TIMEOUT_MS).toBe(30 * 60_000);
  });
  it('reuses the tested real-main ancestry guard and isolates immutable historical source', () => {
    expect(workflow.jobs['validate-source']).toEqual(recovery.jobs['validate-source']);
    for (const job of Object.values(workflow.jobs))
      expect(job.if).toBe("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
    const historical = workflow.jobs.diagnose.steps.find((step) => step.name === 'Checkout frozen source');
    expect(historical?.with).toEqual({
      ref: '${{ needs.validate-source.outputs.source-sha }}',
      path: 'historical',
      'persist-credentials': false,
    });
  });
  it('fails closed on a different Xcode identity before helper execution', () => {
    const step = workflow.jobs.diagnose.steps.find((entry) => entry.name === 'Require original toolchain identity');
    expect(step?.run).toContain("grep -qx 'Build version 27B52'");
    expect(step?.run).toContain('= 27.2');
    expect(step?.run).toContain('= 24B8118');
    // Parse the actual workflow's shell before macOS execution.
    for (const job of Object.values(workflow.jobs))
      for (const entry of job.steps)
        if (entry.run) {
          expect(spawnSync('bash', ['-n'], { input: entry.run, encoding: 'utf8' }).status).toBe(0);
        }
  });
});
