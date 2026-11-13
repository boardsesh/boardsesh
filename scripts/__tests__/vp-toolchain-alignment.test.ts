import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type PackageManifest = {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const manifestAt = (path: string): PackageManifest => JSON.parse(readFileSync(path, 'utf8')) as PackageManifest;

describe('unified test toolchain', () => {
  const installed = manifestAt('node_modules/vite-plus/package.json');
  const root = manifestAt('package.json');
  const workspace = parse(readFileSync('pnpm-workspace.yaml', 'utf8')) as {
    overrides: Record<string, string>;
  };
  const bundledVitest = installed.dependencies?.vitest;

  it('keeps Vite and Vitest on the versions used by the installed runner', () => {
    expect(bundledVitest).toMatch(/^\d+\.\d+\.\d+$/);
    expect(root.devDependencies?.['vite-plus']).toBe(installed.version);
    expect(root.devDependencies?.vite).toBe(`npm:@voidzero-dev/vite-plus-core@${installed.version}`);
    expect(workspace.overrides['vite@*']).toBe(root.devDependencies?.vite);
    expect(workspace.overrides['vitest@*']).toBe(bundledVitest);
  });

  it('aligns every declared workspace test runner and coverage provider', () => {
    const workspaceManifests = ['package.json'];
    for (const directory of ['packages', 'packages/shared']) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name, 'package.json');
        if (entry.isDirectory() && existsSync(path)) workspaceManifests.push(path);
      }
    }
    for (const path of workspaceManifests) {
      const manifest = manifestAt(path);
      for (const packageName of ['vitest', '@vitest/coverage-v8']) {
        const declared = manifest.devDependencies?.[packageName] ?? manifest.dependencies?.[packageName];
        if (declared) expect(declared, `${path}: ${packageName}`).toBe(bundledVitest);
      }
    }
  });
});
/// <reference types="node" />
