// @vitest-environment node
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vite-plus/test';

type Lifecycle = {
  inlineTasks: number;
  tasks: { phase: string; rootTaskSpawnPhase: string }[];
  requestClosed: boolean;
  remainingCloseListeners: number;
};
type Provider = {
  name: string;
  direct: {
    calls: { order: string; receiver: boolean; arguments: number }[];
    synchronousCalls: number;
    sameError: boolean;
    remainingCloseListeners: number;
  };
  pendingClose: {
    state: string;
    callsBeforeActualClose: number;
    callsAfterClose: number;
    remainingCloseListeners: number;
  }[];
  comparisons: Record<string, { normal: Lifecycle; ordinaryLate: Lifecycle; recovered: Lifecycle }>;
  graph: {
    responseHeld: boolean;
    tasks: number;
    remainingCloseListeners: number;
    surviving: { stores: number; contexts: number; units: number };
  };
};
type Route = {
  scenario: string;
  responseClosed: boolean;
  registrations: boolean[];
  tasks: string[];
  requestClosed: boolean;
  remainingCloseListeners: number;
  body: string;
};
const names = [
  'dist/build/templates/app-page-runtime.js',
  'dist/esm/build/templates/app-page-runtime.js',
  'dist/build/templates/app-route.js',
  'dist/esm/build/templates/app-route.js',
  'NodeNextResponse CJS',
  'NodeNextResponse ESM',
  'minimal production response',
];
let report: { providers: Provider[]; routes: Route[] };
const execute = promisify(execFile);
beforeAll(async () => {
  const { stdout } = await execute(
    process.execPath,
    ['--expose-gc', fileURLToPath(new URL('./fixtures/next-closed-registration.cjs', import.meta.url))],
    { env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'test' }, timeout: 30_000, maxBuffer: 256 * 1024 },
  );
  report = JSON.parse(stdout) as typeof report;
  expect(report.providers.map((provider) => provider.name)).toEqual(names);
}, 35_000);

describe.each(names)('already-closed provider %s', (name) => {
  const provider = () => report.providers.find((candidate) => candidate.name === name)!;
  it('delivers immediately with the receiver and original thrown error, attaching no listener', () => {
    expect(provider().direct).toEqual({
      calls: [
        { order: 'first', receiver: true, arguments: 0 },
        { order: 'second', receiver: true, arguments: 0 },
      ],
      synchronousCalls: 2,
      sameError: true,
      remainingCloseListeners: 0,
    });
  });
  it('waits for close when destroyed or writable-finished alone is true', () => {
    expect(provider().pendingClose).toEqual(
      ['destroyed', 'writableFinished', 'both'].map((state) => ({
        state,
        callsBeforeActualClose: 0,
        callsAfterClose: 1,
        remainingCloseListeners: 0,
      })),
    );
  });
  it.each(['render', 'action'])(
    'matches the existing close-before-first-after lifecycle for a fresh %s unit',
    (phase) => {
      const comparison = provider().comparisons[phase];
      expect(comparison.normal).toEqual({
        inlineTasks: 0,
        tasks: [{ phase: 'after', rootTaskSpawnPhase: phase }],
        requestClosed: true,
        remainingCloseListeners: 0,
      });
      // Next already leaves a newly registered unit in its original phase when
      // close preceded its first after() call. This memory fix preserves that.
      expect(comparison.ordinaryLate).toEqual({
        inlineTasks: 0,
        tasks: [{ phase, rootTaskSpawnPhase: phase }],
        requestClosed: true,
        remainingCloseListeners: 0,
      });
      expect(comparison.recovered).toEqual(comparison.ordinaryLate);
    },
  );
  it('collects recovered completed request graphs while their response remains held', () => {
    expect(provider().graph).toEqual({
      responseHeld: true,
      tasks: 4,
      remainingCloseListeners: 0,
      surviving: { stores: 0, contexts: 0, units: 0 },
    });
  });
});

it.each(['abort', 'stale-isr'])(
  'runs after() when real AppRoute module loading resumes after %s closes the response',
  (scenario) => {
    expect(report.routes.find((route) => route.scenario === scenario)).toEqual({
      scenario,
      responseClosed: true,
      registrations: [true],
      tasks: ['after'],
      requestClosed: true,
      remainingCloseListeners: 0,
      body: scenario === 'abort' ? '' : 'cached',
    });
  },
);
