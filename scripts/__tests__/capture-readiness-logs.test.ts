import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { snapshotCaptureLogs, waitForCaptureLogLine } from '../lib/capture-readiness-logs';
import { launchIosCaptureReady } from '../lib/ios-capture-ready';
import { settleAfterStory } from '../lib/mobile-stories';

vi.mock('../lib/exec', () => ({ sleepSeconds: vi.fn() }));
let directory: string;
let paths: string[];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'capture-readiness-'));
  paths = [join(directory, 'metro.log'), join(directory, 'native.log')];
  for (const path of paths) writeFileSync(path, '');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('accepts native-only root readiness without accepting an earlier process marker', () => {
  const marker = '[stories] root ready';
  writeFileSync(paths[1], `${marker}\n`);
  const boundaries = snapshotCaptureLogs(paths);
  expect(waitForCaptureLogLine((line) => line.includes(marker), boundaries, 0)).toBeNull();
  appendFileSync(paths[1], `Boardsesh[64048] [javascript] ${marker}\n`);
  expect(waitForCaptureLogLine((line) => line.includes(marker), boundaries, 0)).toContain(marker);
});

it('excludes late old-process pings during termination but accepts a new native ping', () => {
  let launches = 0;
  const ready = '[stories] root ready\n';
  const result = launchIosCaptureReady({
    snapshot: () => snapshotCaptureLogs(paths),
    launch: () => {
      launches++;
      if (launches === 3) appendFileSync(paths[1], ready);
      return true;
    },
    terminate: () => {
      paths.forEach((path) => appendFileSync(path, ready));
      return true;
    },
    beforeRetry: () => {},
    waitReady: (boundaries) => waitForCaptureLogLine((line) => line.includes(ready.trim()), boundaries, 0) !== null,
  });
  expect(result).toBe(true);
  expect(launches).toBe(3);
});

it('settles a native-only story readiness marker with Metro silent', () => {
  const boundaries = snapshotCaptureLogs(paths, paths[1]);
  appendFileSync(
    paths[1],
    `${boundaries[1].nativeSince} I Boardsesh[64048:23f28] [com.facebook.react.log:javascript] [stories] ready wall-status--connected\n`,
  );
  expect(() => settleAfterStory('wall-status--connected', paths[0], 0, 0, '[test]', boundaries.slice(1))).not.toThrow();
});

it.each([0, 1])('rejects an error on stream %s even when the other stream is ready', (errorStream) => {
  const boundaries = snapshotCaptureLogs(paths);
  appendFileSync(paths[1 - errorStream], '[stories] ready wall-status--connected\n');
  appendFileSync(paths[errorStream], '[stories] error wall-status--connected Missing image\n');
  expect(() => settleAfterStory('wall-status--connected', paths[0], 0, 0, '[test]', boundaries.slice(1))).toThrow(
    'Missing image',
  );
});

it.each(['missing', 'scenario'])('rejects native %s events', (kind) => {
  const boundaries = snapshotCaptureLogs(paths);
  appendFileSync(paths[1], `[stories] ${kind} wall-status--connected -> /climbs\n`);
  expect(() => settleAfterStory('wall-status--connected', paths[0], 0, 0, '[test]', boundaries.slice(1))).toThrow();
});

it('rejects buffered native events emitted before the boundary but appended afterward', () => {
  const boundaries = snapshotCaptureLogs(paths, paths[1]);
  appendFileSync(paths[1], '2026-01-01 00:00:00.000 I Boardsesh[123] [stories] root ready\n');
  const matches = (line: string) => line.includes('[stories] root ready');
  expect(waitForCaptureLogLine(matches, boundaries, 0)).toBeNull();
  appendFileSync(paths[1], `${boundaries[1].nativeSince} I Boardsesh[456] [stories] root ready\n`);
  expect(waitForCaptureLogLine(matches, boundaries, 0)).toContain('Boardsesh[456]');
});

it.each(['missing', 'scenario'])('does not let Metro ready hide a native %s event', (kind) => {
  const boundaries = snapshotCaptureLogs(paths);
  appendFileSync(paths[0], '[stories] ready wall-status--connected\n');
  appendFileSync(paths[1], `[stories] ${kind} wall-status--connected -> /climbs\n`);
  expect(() => settleAfterStory('wall-status--connected', paths[0], 0, 0, '[test]', boundaries.slice(1))).toThrow();
});
