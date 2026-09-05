/// <reference types="node" />

import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkspaceManifest {
  name: string;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const repoRoot = resolve(import.meta.dirname, '../..');
const workspace = parse(readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')) as { packages: string[] };
const packages = new Map(
  globSync(
    workspace.packages.map((pattern) => `${pattern}/package.json`),
    { cwd: repoRoot },
  ).map((manifestPath) => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, manifestPath), 'utf8')) as WorkspaceManifest;
    return [manifest.name, { manifest, directory: join(repoRoot, dirname(manifestPath)) }];
  }),
);

function workspaceDependencies(manifest: WorkspaceManifest): string[] {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  }).filter((name) => packages.has(name));
}

describe('workspace install manifests', () => {
  it('keeps the workspace dependency graph acyclic, including test dependencies', () => {
    const visited = new Set<string>();
    const visit = (name: string, ancestors: string[]): void => {
      expect(ancestors, `Workspace cycle: ${[...ancestors, name].join(' -> ')}`).not.toContain(name);
      if (visited.has(name)) return;
      const { manifest } = packages.get(name)!;
      for (const dependency of workspaceDependencies(manifest)) {
        visit(dependency, [...ancestors, name]);
      }
      visited.add(name);
    };
    for (const name of packages.keys()) visit(name, []);
  });

  it('provides bin targets before building packages that link workspace commands', () => {
    const linkedPackages = new Set([...packages.values()].flatMap(({ manifest }) => workspaceDependencies(manifest)));
    for (const name of linkedPackages) {
      const { manifest, directory } = packages.get(name)!;
      const binaries = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
      for (const binary of binaries) {
        expect(existsSync(join(directory, binary)), `${name}: missing workspace bin ${binary}`).toBe(true);
      }
    }
  });
});
