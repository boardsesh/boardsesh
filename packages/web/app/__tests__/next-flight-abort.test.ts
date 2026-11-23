// @vitest-environment node
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vite-plus/test';

type FlightReport = {
  artifact: string;
  completion: { complete: boolean; aborts: number; reported: string[]; closeListeners: number };
  disconnect: {
    clientAborted: boolean;
    abortNames: string[];
    errorNames: string[];
    reported: string[];
    completionMarkers: number;
    signalListeners: number;
  };
  explicitAbort: {
    sameReason: boolean;
    aborts: number;
    reported: string[];
    completionMarkers: number;
    signalListeners: number;
  };
  genuineFailure: { sameError: boolean; reported: string[]; aborts: number };
};

const artifacts = [
  'dist/server/app-render/stream-ops.node.js',
  'dist/esm/server/app-render/stream-ops.node.js',
  ...[
    'app-page-experimental.runtime.dev.js',
    'app-page-experimental.runtime.prod.js',
    'app-page-turbo-experimental.runtime.dev.js',
    'app-page-turbo-experimental.runtime.prod.js',
    'app-page-turbo.runtime.dev.js',
    'app-page-turbo.runtime.prod.js',
    'app-page.runtime.dev.js',
    'app-page.runtime.prod.js',
  ].map((artifact) => `dist/compiled/next-server/${artifact}`),
];
const execute = promisify(execFile);
let reports: FlightReport[];

beforeAll(async () => {
  const { stdout } = await execute(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/next-flight-abort.cjs', import.meta.url))],
    { env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'production' }, timeout: 30_000, maxBuffer: 128 * 1024 },
  );
  reports = JSON.parse(stdout) as FlightReport[];
  expect(reports.map((report) => report.artifact)).toEqual(artifacts);
}, 35_000);

describe.each(artifacts)('installed Flight helper %s', (artifact) => {
  const report = () => reports.find((candidate) => candidate.artifact === artifact)!;

  it('streams successful responses without aborting completed renders', () => {
    // React keeps its own close listener; the cancellation hook must release itself.
    expect(report().completion).toEqual({ complete: true, aborts: 0, reported: [], closeListeners: 1 });
  });

  it('cancels disconnected clients without reporting a render failure', () => {
    expect(report().disconnect).toEqual({
      clientAborted: true,
      abortNames: ['ResponseAborted'],
      errorNames: ['ResponseAborted'],
      reported: [],
      completionMarkers: 0,
      signalListeners: 0,
    });
  });

  it('keeps an explicit cancellation reason and releases its signal listener', () => {
    expect(report().explicitAbort).toEqual({
      sameReason: true,
      aborts: 1,
      reported: [],
      completionMarkers: 0,
      signalListeners: 0,
    });
  });

  it('still reports genuine server render errors', () => {
    expect(report().genuineFailure).toEqual({
      sameError: true,
      reported: ['actual-flight-render-failure'],
      aborts: 0,
    });
  });
});
