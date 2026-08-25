/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { getWorkspacePackageMap, services } from '../create-service-docker-context.mjs';

const WORKFLOW_PATH = '.github/workflows/ci.yml';
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');

/**
 * Return one YAML mapping entry by exact key and indentation. Copied from
 * ci-rest-surface-workflow.test.ts / ci-lint-scope.test.ts on purpose: the repo
 * declares no YAML parser, and a CI contract test is not worth the dependency
 * churn.
 */
function mappingEntry(source: string, key: string, indentation: number): string {
  const lines = source.split('\n');
  const prefix = `${' '.repeat(indentation)}${key}:`;
  const startIndex = lines.findIndex((line) => line.startsWith(prefix));
  if (startIndex < 0) {
    throw new Error(`missing ${key} mapping at indentation ${indentation}`);
  }

  let endIndex = lines.length;
  for (let lineIndex = startIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const lineIndentation = line.length - line.trimStart().length;
    if (lineIndentation <= indentation) {
      endIndex = lineIndex;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n');
}

/** Strip `#` comment lines so a job's rationale can never satisfy an assertion. */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/** The `- 'some/glob/**'` entries of a paths-filter block, quotes and glob suffix stripped. */
function filterPathPrefixes(filterBlock: string): string[] {
  return [...withoutComments(filterBlock).matchAll(/^\s*-\s*'([^']+)'\s*$/gm)].map(([, glob]) =>
    glob.endsWith('/**') ? glob.slice(0, -'/**'.length) : glob,
  );
}

/**
 * Re-run create-service-docker-context.mjs's own transitive workspace-dependency
 * walk. The generated web context is the union of the walks from every name in
 * `services.web.rootPackageNames`; this walks the roots it is given so the test
 * can ask two different questions of the same algorithm.
 */
function workspaceClosure(rootPackageNames: string[]): string[] {
  const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;
  const workspacesByName = getWorkspacePackageMap() as Map<
    string,
    { packageDirectory: string; packageJson: Record<string, Record<string, string> | undefined> }
  >;

  const visitedPackageNames = new Set<string>();
  const pendingPackageNames = [...rootPackageNames];
  while (pendingPackageNames.length > 0) {
    const packageName = pendingPackageNames.pop();
    if (packageName === undefined || visitedPackageNames.has(packageName)) continue;
    visitedPackageNames.add(packageName);

    const workspace = workspacesByName.get(packageName);
    if (!workspace) throw new Error(`${packageName} is not a root workspace`);
    for (const field of dependencyFields) {
      for (const dependencyName of Object.keys(workspace.packageJson[field] ?? {})) {
        if (workspacesByName.has(dependencyName)) pendingPackageNames.push(dependencyName);
      }
    }
  }

  return [...visitedPackageNames].map((packageName) => workspacesByName.get(packageName)!.packageDirectory).sort();
}

/**
 * `docker-web` is the only thing in CI that runs `next build` for web, and
 * #3795 turns the image it builds into the www production artifact. Everything
 * asserted here is a property that would otherwise fail open — a filter that
 * stops covering a package the image is built from, a cache write that quietly
 * starts running on PRs, a push that quietly starts publishing — none of which
 * turns the job red on its own.
 */
describe('docker-web CI job contract', () => {
  const changesJob = mappingEntry(workflowSource, 'changes', 2);
  const dockerWebFilter = mappingEntry(changesJob, 'dockerWeb', 12);
  const dockerWebJob = mappingEntry(workflowSource, 'docker-web', 2);
  const dockerWebSteps = withoutComments(dockerWebJob);
  const ciStatusJob = withoutComments(mappingEntry(workflowSource, 'ci-status', 2));

  it('publishes a dockerWeb gate that hardcodes true off pull requests', () => {
    // The `github.event_name != 'pull_request'` half is the backstop: it is what
    // makes the job run on every push to main regardless of the filter, which is
    // both the safety net for whatever the filter misses and the only thing that
    // ever writes the `web-main` buildx cache.
    expect(changesJob).toContain(
      "dockerWeb: ${{ github.event_name != 'pull_request' && 'true' || steps.filter.outputs.dockerWeb }}",
    );
  });

  it('covers every workspace package the web image is built from', () => {
    // Derived, not pinned. A new workspace dependency on @boardsesh/web opens a
    // hole in the filter that nothing else notices — the job simply stops
    // running for changes to that package — so re-derive the closure here and
    // fail if the filter no longer covers it.
    const coveredPrefixes = filterPathPrefixes(dockerWebFilter);
    const uncovered = workspaceClosure(['@boardsesh/web']).filter(
      (packageDirectory) =>
        !coveredPrefixes.some((prefix) => packageDirectory === prefix || packageDirectory.startsWith(`${prefix}/`)),
    );

    expect(uncovered).toEqual([]);
  });

  it('leaves the mobile-only half of the generated context out of the filter', () => {
    // services.web still roots the context walk at @boardsesh/mobile as well,
    // so packages/mobile and its exclusive deps are copied into the context —
    // but W-24 (#4438) deleted the Expo export step, so nothing in the image
    // builds or runs them, and W-26 (#4442) drops them from the context. Mobile
    // is the highest-churn tree in the repo; gating a 4-minute build on it
    // would make most PRs pay for bytes the runner never sees. This assertion is
    // the cost decision, written down. It self-retires: once W-26 removes the
    // mobile root, the set below is empty and nothing is asserted.
    const { rootPackageNames } = services.web as { rootPackageNames: string[] };
    const webClosure = new Set(workspaceClosure(['@boardsesh/web']));
    const mobileOnlyDirectories = workspaceClosure(rootPackageNames).filter(
      (packageDirectory) => !webClosure.has(packageDirectory),
    );

    const coveredPrefixes = filterPathPrefixes(dockerWebFilter);
    for (const packageDirectory of mobileOnlyDirectories) {
      expect(coveredPrefixes).not.toContain(packageDirectory);
    }
  });

  it('covers the install inputs the image build cannot start without', () => {
    const filter = withoutComments(dockerWebFilter);
    expect(filter).toContain("- 'Dockerfile.web'");
    expect(filter).toContain("- 'bun.lock'");
    expect(filter).toContain("- 'package.json'");
    // bun resolves patchedDependencies before the deps stage can install at all.
    expect(filter).toContain("- 'patches/**'");
    // The generator that produces the context, and the config defining the
    // `docker-context:web` script the job invokes.
    expect(filter).toContain("- 'scripts/create-service-docker-context.mjs'");
    expect(filter).toContain("- 'vite.config.ts'");
    // Copied into the context by services.web.extraSourceFiles. Next's
    // production type-check compiles packages/web/scripts, which imports
    // tailscale-hostname.ts, so an edit there can break the image build.
    const { extraSourceFiles } = services.web as { extraSourceFiles: string[] };
    for (const extraSourceFile of extraSourceFiles) {
      expect(filter).toContain(`- '${extraSourceFile}'`);
    }
  });

  it('runs the job on diffs to the job itself', () => {
    // Neither entry is an image input. They are what stops a ci.yml-only PR
    // from narrowing the filter, gutting an assertion or deleting the job and
    // going green: this spec reads ci.yml with readFileSync, so Vitest's
    // `--changed` module-graph analysis in test-default can never relate it to
    // such a diff. Without them the gate could be quietly reverted by the exact
    // change shape it exists to catch — and, on the PR that introduced it, the
    // job would never have run in CI even once before merging.
    const filter = withoutComments(dockerWebFilter);
    expect(filter).toContain("- '.github/workflows/ci.yml'");
    expect(filter).toContain("- 'scripts/__tests__/ci-docker-web-workflow.test.ts'");
  });

  it('runs only when the web image inputs change', () => {
    expect(dockerWebSteps).toContain("if: needs.changes.outputs.dockerWeb == 'true'");
  });

  it('builds the generated context rather than the repo root', () => {
    expect(dockerWebSteps).toContain('run: vp run docker-context:web');
    expect(dockerWebSteps).toContain('context: .docker-context/web');
    expect(dockerWebSteps).toContain('file: .docker-context/web/Dockerfile');
  });

  it('never publishes the image it builds', () => {
    // The whole value of a build-only gate is that it cannot ship anything. A
    // push here would need registry credentials this job deliberately lacks.
    expect(dockerWebSteps).toContain('push: false');
    expect(dockerWebSteps).not.toContain('docker/login-action');
    expect(dockerWebSteps).not.toContain('packages: write');
    expect(dockerWebSteps).not.toContain('attest-build-provenance');
  });

  it('writes the shared buildx cache from main only', () => {
    // GitHub gives the repo 10 GB of Actions cache and it already sits at
    // ~8.2 GB. This image's node_modules layer alone is 2.7 GB uncompressed, so
    // PR writes would evict the gradle and vp toolchain caches by LRU. Widening
    // this to every branch is invisible in review and only shows up as other
    // jobs getting slower, so pin the guard.
    expect(dockerWebSteps).toContain('cache-from: type=gha,scope=web-main');
    expect(dockerWebSteps).toContain(
      "cache-to: ${{ github.ref == 'refs/heads/main' && 'type=gha,mode=max,scope=web-main' || '' }}",
    );
  });

  it('asserts the three things the image is built to prove', () => {
    // The board-renderer WASM reaches the standalone output only through
    // next.config.mjs's outputFileTracingIncludes, and the size floor is what
    // makes the check survive a 0-byte stub.
    expect(dockerWebSteps).toContain('board_renderer_wasm_bg.wasm');
    expect(dockerWebSteps).toContain('-gt 400000');
    // public/openapi.json is gitignored, so its presence proves generate:openapi
    // ran; counting paths is what makes an empty document fail.
    expect(dockerWebSteps).toContain('/app/packages/web/public/openapi.json');
    expect(dockerWebSteps).toContain('spec.paths');
    // The GraphQL SWC plugin's artifactDirectory is READ OUT of next.config.mjs
    // rather than pinned in the workflow, so an edit to it is checked against
    // the real context instead of a second copy of the same mistake.
    expect(dockerWebSteps).toContain('artifactDirectory');
    expect(dockerWebSteps).toContain('packages/web/next.config.mjs');
    expect(dockerWebSteps).not.toContain("artifactDirectory: './packages/shared/graphql");
  });

  it('makes the aggregate status depend on the job', () => {
    expect(ciStatusJob).toContain('- docker-web');
  });
});
