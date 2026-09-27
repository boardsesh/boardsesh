import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERIAL_TEST_FILES } from '../../packages/backend/vitest-serial-files.ts';
import { describe, expect, it } from 'vitest';
import { INFRA_PROJECTS, selectTestDefaultProjects, type ConfigReader } from '../ci-test-default-projects';

// Fixtures so tests never touch the real configs: a root config that lists
// project config paths, and a per-path map of each project's vite.config source.
function rootConfig(paths: string[]): string {
  return `import { defineConfig } from 'vite-plus';\nexport default defineConfig({\n  test: {\n    projects: [\n${paths
    .map((path) => `      '${path}',`)
    .join('\n')}\n    ],\n  },\n});\n`;
}

function projectConfig(name: string): string {
  return `export default defineConfig({ test: { name: '${name}', environment: 'node' } });`;
}

function reader(map: Record<string, string>): ConfigReader {
  return (relativePath) => {
    const source = map[relativePath];
    if (source === undefined) throw new Error(`unexpected read of ${relativePath}`);
    return source;
  };
}

describe('selectTestDefaultProjects', () => {
  it('returns every project name except the infra ones, in declared order', () => {
    const paths = [
      './packages/web/vite.config.ts',
      './packages/backend/vite.config.ts',
      './packages/location-sync/vite.config.ts',
      './packages/shared/queue/vite.config.ts',
      './packages/moonboard-ocr/vite.config.ts',
      './scripts/vite.config.ts',
    ];
    const map = {
      './packages/web/vite.config.ts': projectConfig('web'),
      './packages/backend/vite.config.ts': projectConfig('backend'),
      './packages/location-sync/vite.config.ts': projectConfig('location-sync'),
      './packages/shared/queue/vite.config.ts': projectConfig('queue'),
      './packages/moonboard-ocr/vite.config.ts': projectConfig('moonboard-ocr'),
      './scripts/vite.config.ts': projectConfig('scripts'),
    };

    expect(selectTestDefaultProjects(rootConfig(paths), reader(map))).toEqual(['web', 'queue', 'scripts']);
  });

  it('auto-includes a newly added project (no hand-maintained list to update)', () => {
    const paths = ['./packages/web/vite.config.ts', './packages/shared/board-react/vite.config.ts'];
    const map = {
      './packages/web/vite.config.ts': projectConfig('web'),
      './packages/shared/board-react/vite.config.ts': projectConfig('board-react'),
    };

    expect(selectTestDefaultProjects(rootConfig(paths), reader(map))).toContain('board-react');
  });

  it('reads the name from the test block, ignoring a plugin name: above it', () => {
    const paths = ['./packages/web/vite.config.ts'];
    const config = `export default defineConfig({ plugins: [{ name: 'some-plugin' }], test: { name: 'web' } });`;

    expect(selectTestDefaultProjects(rootConfig(paths), reader({ './packages/web/vite.config.ts': config }))).toEqual([
      'web',
    ]);
  });

  it('throws when the root config has no test.projects entries', () => {
    expect(() => selectTestDefaultProjects(`export default defineConfig({ test: {} });`, reader({}))).toThrow(
      /no test\.projects entries/,
    );
  });

  it('throws (does not silently skip) when a project config has no test name', () => {
    const paths = ['./packages/web/vite.config.ts'];
    const config = `export default defineConfig({ test: { environment: 'node' } });`;

    expect(() =>
      selectTestDefaultProjects(rootConfig(paths), reader({ './packages/web/vite.config.ts': config })),
    ).toThrow(/could not extract a test "name" from \.\/packages\/web\/vite\.config\.ts/);
  });

  it('throws when every project is excluded (refuses to run zero projects)', () => {
    const paths = ['./packages/backend/vite.config.ts', './packages/moonboard-ocr/vite.config.ts'];
    const map = {
      './packages/backend/vite.config.ts': projectConfig('backend'),
      './packages/moonboard-ocr/vite.config.ts': projectConfig('moonboard-ocr'),
    };

    expect(() => selectTestDefaultProjects(rootConfig(paths), reader(map))).toThrow(/empty/);
  });

  it('honours a caller-supplied infra set', () => {
    const paths = ['./packages/web/vite.config.ts', './packages/shared/queue/vite.config.ts'];
    const map = {
      './packages/web/vite.config.ts': projectConfig('web'),
      './packages/shared/queue/vite.config.ts': projectConfig('queue'),
    };

    expect(selectTestDefaultProjects(rootConfig(paths), reader(map), new Set(['web']))).toEqual(['queue']);
  });

  it('documents the infra projects excluded by default', () => {
    expect([...INFRA_PROJECTS].sort()).toEqual(['backend', 'backend-serial', 'location-sync', 'moonboard-ocr']);
  });
});

describe('where the backend projects run in CI', () => {
  const ciWorkflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const rootConfig = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');
  /** Every `vp test run ...` invocation in the workflow, with its continuation lines joined. */
  const vpTestRuns = ciWorkflow
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('vp test run'));

  it('shards `backend` and never puts `backend-serial` in a sharded run', () => {
    const backendRuns = vpTestRuns.filter((run) => /--project backend(\s|$)/.test(run));
    expect(backendRuns.length).toBeGreaterThan(0);
    for (const run of backendRuns) {
      expect(run).toContain('--shard=');
      expect(run).not.toContain('backend-serial');
    }
  });

  it('runs `backend-serial` alone, unsharded, in one job of the matrix', () => {
    const serialRuns = vpTestRuns.filter((run) => run.includes('--project backend-serial'));
    expect(serialRuns).toHaveLength(1);
    expect(serialRuns[0]).not.toContain('--shard');
    expect(serialRuns[0].match(/--project /g)).toHaveLength(1);
    const serialStep = ciWorkflow.slice(ciWorkflow.indexOf('- name: Run backend-serial tests'));
    expect(serialStep.split('\n')[1]).toContain('matrix.shard == 1');
  });

  it('orders `backend-serial` after `backend` when one run holds both (the root `vp test`)', () => {
    const serialConfig = readFileSync(new URL('../../packages/backend/vite.serial.config.ts', import.meta.url), 'utf8');
    const backendConfig = readFileSync(new URL('../../packages/backend/vite.config.ts', import.meta.url), 'utf8');
    const groupOrder = (source: string) => Number(/groupOrder:\s*(\d+)/.exec(source)?.[1] ?? '0');
    expect(groupOrder(serialConfig)).toBeGreaterThan(groupOrder(backendConfig));
  });

  it('runs the two projects one after the other in `vp run test:backend`', () => {
    expect(rootConfig).toContain("command: 'vp test run --project backend && vp test run --project backend-serial'");
  });
});

describe('which backend tests must run in backend-serial', () => {
  const backendRoot = fileURLToPath(new URL('../../packages/backend/', import.meta.url));

  function testFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(path);
      return entry.name.endsWith('.test.ts') ? [path] : [];
    });
  }

  it('lists every backend test that starts a real PgBoss', () => {
    const startsPgBoss = testFiles(join(backendRoot, 'src'))
      .filter((path) => /new PgBoss\(|boss\.start\(\)|startJobQueue\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(backendRoot, path).split('\\').join('/'));
    expect(startsPgBoss.length).toBeGreaterThan(0);
    for (const file of startsPgBoss) expect(SERIAL_TEST_FILES).toContain(file);
  });

  it('runs the Kilter catalog fence test serially (it drives the shared kilter catalog cursor)', () => {
    expect(SERIAL_TEST_FILES).toContain('src/workers/families/__tests__/kilter-catalog-fence.test.ts');
  });

  it('lists only files that exist', () => {
    for (const file of SERIAL_TEST_FILES) expect(() => readFileSync(join(backendRoot, file))).not.toThrow();
  });
});
