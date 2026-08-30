/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The root `typecheck` aggregate deliberately depends on `build:X` instead of
// `typecheck:X` for nine packages: both run tsc over the same tsconfig, so
// listing both compiled each package twice (51 CPU-seconds of duplicate work
// per CI run). Emit-mode tsc reports a superset of `--noEmit` diagnostics, so
// nothing is lost — WHILE the premise holds.
//
// The premise is invisible from vite.config.ts, and its failure is silent: if
// one of these packages switches `build` to a bundler, or gains a
// tsconfig.build.json that excludes tests, the aggregate stops type-checking it
// and nothing goes red. Coverage just evaporates. A comment cannot fail, so
// this test is the guard.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Packages whose `typecheck:X` was replaced by `build:X` in the aggregate, as
 * [vp task suffix, package dir]. The task suffix does NOT track the directory
 * name (`build:shared` builds packages/shared-schema, `build:aurora` builds
 * packages/aurora-sync), so both are spelled out rather than derived.
 */
const BUILD_COVERS_TYPECHECK = [
  ['shared', 'packages/shared-schema'],
  ['db', 'packages/db'],
  ['backend', 'packages/backend'],
  ['aurora', 'packages/aurora-sync'],
  ['kilter', 'packages/kilter-sync'],
  ['location-sync', 'packages/location-sync'],
  ['moonboard-sync', 'packages/moonboard-sync'],
  ['quantum-sync', 'packages/quantum-sync'],
  ['sync-runtime', 'packages/sync-runtime'],
] as const;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
}

describe('typecheck aggregate: build:X may only stand in for typecheck:X while both run the same tsc', () => {
  it.each(BUILD_COVERS_TYPECHECK)('%s builds with plain tsc, not a bundler', (_name, packageDir) => {
    const scripts = readJson(`${packageDir}/package.json`).scripts as Record<string, string> | undefined;
    const build = scripts?.build ?? '';

    // `tsc` (optionally with flags) and nothing else. A bundler emits JS without
    // ever type-checking, which is exactly the silent-coverage-loss case.
    expect(build, `${packageDir} build script must be tsc for the typecheck aggregate to cover it`).toMatch(
      /^tsc(\s|$)/,
    );
    for (const bundler of ['tsup', 'esbuild', 'bun build', 'rollup', 'swc', 'babel']) {
      expect(
        build,
        `${packageDir} build switched to ${bundler} — restore typecheck:${_name} in vite.config.ts`,
      ).not.toContain(bundler);
    }
  });

  it.each(BUILD_COVERS_TYPECHECK)('%s has no tsconfig.build.json narrowing what build sees', (_name, packageDir) => {
    // A separate build tsconfig is the other way the premise breaks: build would
    // compile a narrower file set (typically src minus tests) than typecheck did.
    let exists = true;
    try {
      readFileSync(resolve(REPO_ROOT, `${packageDir}/tsconfig.build.json`), 'utf8');
    } catch {
      exists = false;
    }
    expect(exists, `${packageDir} gained a tsconfig.build.json — restore typecheck:${_name} in vite.config.ts`).toBe(
      false,
    );
  });

  it('keeps every one of those build:X entries in the typecheck aggregate', () => {
    const config = readFileSync(resolve(REPO_ROOT, 'vite.config.ts'), 'utf8');
    const aggregate = config.match(/^ {6}typecheck: \{\n[\s\S]*?^ {6}\},$/m)?.[0];
    expect(aggregate, 'vite.config.ts must define a `typecheck` aggregate task').toBeTruthy();

    // Spelled out rather than left to arrive transitively, so an unrelated edit
    // to someone else's dependsOn cannot quietly drop one out of the graph.
    // Either spelling is acceptable: `build:X` is today's dedup, `typecheck:X`
    // is the correct restoration if a package ever breaks the tsc premise above.
    for (const [task, packageDir] of BUILD_COVERS_TYPECHECK) {
      expect(aggregate, `${packageDir} must reach the typecheck aggregate`).toMatch(
        new RegExp(`'(build|typecheck):${task}'`),
      );
    }
  });
});
