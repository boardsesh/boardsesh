import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync } from 'node:fs';
import { createScreenshotBackend, readScreenshotFixtureManifest } from '../screenshot-backend';
import {
  ensureScreenshotFixtures,
  readFixtureSnapshotReference,
  type FixtureSnapshotReference,
} from '../screenshot-fixture-snapshot';

export const OBSERVATION_FIXTURE: FixtureSnapshotReference = {
  version: 1,
  url: 'https://pub-ce4091dbd55b4b71b1c59a2461a28360.r2.dev/screenshot-fixtures/03ddb626f41d3627f587f3bff1686e2d0cc098630973d14a730f348dfe546ed1.json.gz',
  sha256: '03ddb626f41d3627f587f3bff1686e2d0cc098630973d14a730f348dfe546ed1',
  bytes: 1663568,
  files: 346,
};
export function assertObservationFixture(reference: FixtureSnapshotReference): void {
  if (
    (Object.keys(OBSERVATION_FIXTURE) as (keyof FixtureSnapshotReference)[]).some(
      (key) => reference[key] !== OBSERVATION_FIXTURE[key],
    )
  )
    throw new Error('observation_fixture_pin_changed');
}
export function observationReplayOptions(fixturesDir: string, frozenNow: string, log: (line: string) => void) {
  return { mode: 'replay' as const, upstreamUrl: null, fixturesDir, frozenNow, log };
}
export function replayOperationCounter(line: string): { outcome: string; operationName: string } | null {
  const match = line.match(/\b(HIT|MISS|DEFAULT)\s+graphql\s+([A-Za-z_][A-Za-z0-9_]{0,79})\b/);
  return match ? { outcome: match[1], operationName: match[2] } : null;
}
export async function startPinnedObservationReplay(
  privateLog: string,
  cacheRoot: string,
  snapshot: (phase: 'before' | 'after') => unknown,
) {
  const reference = readFixtureSnapshotReference();
  assertObservationFixture(reference);
  // This is the only external request: the existing public immutable archive GET, with byte/SHA/path validation.
  const fixturesDir = await ensureScreenshotFixtures(reference, cacheRoot);
  const manifest = readScreenshotFixtureManifest(fixturesDir);
  if (!manifest || manifest.frozenNow !== '2026-09-19T14:39:54Z')
    throw new Error('observation_fixture_clock_or_manifest_changed');
  const counters: Record<string, number> = {};
  const backend = createScreenshotBackend(
    observationReplayOptions(fixturesDir, manifest.frozenNow, (line) => {
      appendFileSync(privateLog, line + '\n');
      const operation = replayOperationCounter(line);
      if (operation) {
        const name = `${operation.outcome}:${operation.operationName}`;
        counters[name] = (counters[name] ?? 0) + 1;
      }
    }),
  );
  let sensors: Awaited<ReturnType<typeof startObservationSensorServer>>;
  try {
    await backend.listen(8119, '127.0.0.1');
    sensors = await startObservationSensorServer(snapshot);
  } catch (error) {
    await backend.close();
    throw error;
  }
  return {
    reference,
    frozenNow: manifest.frozenNow,
    stats() {
      return { ...backend.stats(), operations: counters };
    },
    async close() {
      await sensors.close();
      await backend.close();
    },
  };
}

export async function startObservationSensorServer(snapshot: (phase: 'before' | 'after') => unknown, port = 8120) {
  const sensors = createServer(async (request, response) => {
    const phase =
      request.method === 'GET' && request.url === '/__observation/before'
        ? 'before'
        : request.method === 'GET' && request.url === '/__observation/after'
          ? 'after'
          : null;
    if (!phase) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      await snapshot(phase);
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    } catch {
      response.writeHead(500);
      response.end('{"error":"bounded_sensor_snapshot_failed"}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    sensors.once('error', reject);
    sensors.listen(port, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${(sensors.address() as AddressInfo).port}`,
    async close() {
      sensors.closeAllConnections();
      await new Promise<void>((resolve) => sensors.close(() => resolve()));
    },
  };
}
