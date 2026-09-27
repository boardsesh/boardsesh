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
