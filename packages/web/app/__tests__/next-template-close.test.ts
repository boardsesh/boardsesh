// @vitest-environment node
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vite-plus/test';

type TemplateReport = {
  template: string;
  noAfter: { responsesHeld: number; remainingCloseListeners: number; survivingAfterContexts: number };
  lifecycle: {
    beforeClose: string[];
    phaseBeforeClose: string;
    requestClosedBeforeClose: boolean;
    events: string[];
    beforeRepeatedClose: string[];
    phase: string;
    isRequestClosed: boolean;
    fetchMetricsStopped: boolean;
    remainingCloseListeners: number;
  };
  graph: {
    responsesHeld: number;
    completedTasks: number;
    remainingCloseListeners: number;
    surviving: { stores: number; contexts: number; units: number; markers: number };
  };
  throwing: { remainingCloseListeners: number };
};

const templates = [
  'dist/build/templates/app-page-runtime.js',
  'dist/esm/build/templates/app-page-runtime.js',
  'dist/build/templates/app-route.js',
  'dist/esm/build/templates/app-route.js',
];
const execute = promisify(execFile);
let reports: TemplateReport[];

beforeAll(async () => {
  const { stdout } = await execute(
    process.execPath,
    ['--expose-gc', fileURLToPath(new URL('./fixtures/next-template-close.cjs', import.meta.url))],
    { env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'test' }, timeout: 30_000, maxBuffer: 128 * 1024 },
  );
  reports = JSON.parse(stdout) as TemplateReport[];
  expect(reports.map((report) => report.template)).toEqual(templates);
}, 35_000);

describe.each(templates)('installed template %s', (template) => {
  const report = () => reports.find((candidate) => candidate.template === template)!;

  it('releases the AfterContext on a held closed response even without after tasks', () => {
    expect(report().noAfter).toEqual({ responsesHeld: 16, remainingCloseListeners: 0, survivingAfterContexts: 0 });
  });

  it('preserves close order, receiver, after phase, fetch metrics and late after tasks', () => {
    const lifecycle = report().lifecycle;
    expect(lifecycle.beforeClose).toEqual([]);
    expect(lifecycle.phaseBeforeClose).toBe('render');
    expect(lifecycle.requestClosedBeforeClose).toBe(false);
    expect(lifecycle.beforeRepeatedClose).toEqual([
      'close:first',
      'close:second',
      'after:first:after:false',
      'after:second:after',
      'after:late:after',
    ]);
    expect(lifecycle.events).toEqual(lifecycle.beforeRepeatedClose);
    expect(lifecycle.phase).toBe('after');
    expect(lifecycle.isRequestClosed).toBe(true);
    expect(lifecycle.fetchMetricsStopped).toBe(true);
    expect(lifecycle.remainingCloseListeners).toBe(0);
  });

  it('collects completed request graphs while their closed responses remain held', () => {
    expect(report().graph).toEqual({
      responsesHeld: 16,
      completedTasks: 16,
      remainingCloseListeners: 0,
      surviving: { stores: 0, contexts: 0, units: 0, markers: 0 },
    });
  });

  it('removes a throwing callback before propagating its original error', () => {
    expect(report().throwing.remainingCloseListeners).toBe(0);
  });
});
