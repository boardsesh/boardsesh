/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { getServiceSourcePackageDirs, services } from '../create-service-docker-context.mjs';
import { jobBlocks, withoutCommentLines } from './helpers/workflow-yaml';

/**
 * Pins the invisible pairings in Dockerfile.ci and ci-image.yml (issue
 * #5008) that review cannot easily catch: a Dockerfile that "looks more
 * obviously correct" after a refactor but silently breaks the freeze chain,
 * or a workflow authority check drifting out of sync with
 * postgres-image-publisher.yml's boundary.
 */

const DOCKERFILE_PATH = 'Dockerfile.ci';
const WORKFLOW_PATH = '.github/workflows/ci-image.yml';

const dockerfileSource = readFileSync(DOCKERFILE_PATH, 'utf8');
const workflowSource = readFileSync(WORKFLOW_PATH, 'utf8');

function dockerfileLines(): string[] {
  return withoutCommentLines(dockerfileSource).filter((line) => line.trim().length > 0);
}

function firstLineIndexMatching(lines: string[], pattern: RegExp): number {
  return lines.findIndex((line) => pattern.test(line));
}

describe('Dockerfile.ci: ARG-before-FROM positioning', () => {
  // Confirmed empirically while building this file locally: Docker/BuildKit
  // only lets an ARG parameterize a LATER stage's `FROM ${ARG}` if that ARG
  // was declared before the file's FIRST FROM instruction. Declaring it
  // right next to the FROM it parameterizes reads as more obviously correct
  // and fails the build with "base name (...) should not be blank" -- see
  // the comment directly above these ARGs in Dockerfile.ci.
  it('declares GIT_HISTORY_BASE and DAILY_HISTORY_BASE before the first FROM', () => {
    const lines = dockerfileLines();
    const firstFromIndex = firstLineIndexMatching(lines, /^FROM\s/);
    expect(firstFromIndex).toBeGreaterThan(-1);

    const gitHistoryArgIndex = firstLineIndexMatching(lines, /^ARG GIT_HISTORY_BASE=/);
    const dailyHistoryArgIndex = firstLineIndexMatching(lines, /^ARG DAILY_HISTORY_BASE=/);
    expect(gitHistoryArgIndex, 'ARG GIT_HISTORY_BASE=... not found').toBeGreaterThan(-1);
    expect(dailyHistoryArgIndex, 'ARG DAILY_HISTORY_BASE=... not found').toBeGreaterThan(-1);

    expect(gitHistoryArgIndex).toBeLessThan(firstFromIndex);
    expect(dailyHistoryArgIndex).toBeLessThan(firstFromIndex);
  });

  it('has exactly three FROM instructions: toolchain, git-history, ci-image', () => {
    const stageNames = [...dockerfileSource.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gm)].map((match) => match[1]);
    expect(stageNames).toEqual(['toolchain', 'git-history', 'ci-image']);
  });
});

describe('Dockerfile.ci: manifests feed pnpm fetch, never the other way round', () => {
  it('copies every manifest input before RUN pnpm fetch', () => {
    const fetchIndex = dockerfileSource.indexOf('RUN pnpm fetch');
    expect(fetchIndex).toBeGreaterThan(-1);

    for (const copyLine of [
      'COPY manifests/package.json manifests/pnpm-lock.yaml manifests/pnpm-workspace.yaml ./',
      'COPY manifests/packages ./packages',
      'COPY manifests/patches ./patches',
    ]) {
      const copyIndex = dockerfileSource.indexOf(copyLine);
      expect(copyIndex, `missing ${JSON.stringify(copyLine)}`).toBeGreaterThan(-1);
      expect(copyIndex, `${JSON.stringify(copyLine)} must appear before pnpm fetch`).toBeLessThan(fetchIndex);
    }
  });

  it('uses `pnpm fetch`, not `pnpm install` -- fetch is what makes a lockfile-only layer possible', () => {
    const codeLines = dockerfileLines();
    expect(codeLines.some((line) => line.includes('pnpm fetch'))).toBe(true);
    // Scoped to non-comment lines: the header comment legitimately DISCUSSES
    // `pnpm install` (contrasting this file with the sibling Dockerfiles), so
    // scanning the whole file text would false-positive on that prose.
    expect(codeLines.some((line) => /\bpnpm install\b/.test(line))).toBe(false);
  });

  it('never copies real workspace source -- this image is manifests + git packs only', () => {
    // The sibling Dockerfiles copy `source/packages` after their install
    // layer; Dockerfile.ci must never do the equivalent, on purpose (see its
    // header comment: "this image is data-only by design").
    expect(dockerfileSource).not.toMatch(/^COPY source\//m);
    expect(dockerfileSource).not.toMatch(/^COPY packages\//m);
  });
});

describe('create-service-docker-context.mjs: the `ci` service is manifests-only', () => {
  const ciService = services.ci as { dockerfile: string; rootPackageNames: string[] };

  it('declares no root packages, so the dependency walk finds no source dirs', () => {
    expect(ciService.rootPackageNames).toEqual([]);
    expect(getServiceSourcePackageDirs('ci')).toEqual([]);
  });

  it('points at Dockerfile.ci', () => {
    expect(ciService.dockerfile).toBe('Dockerfile.ci');
  });
});

describe('ci-image.yml: build authority is main only', () => {
  const authorizeBlock = jobBlocks(workflowSource).get('authorize-main');

  it('has an authorize-main job', () => {
    expect(authorizeBlock).toBeDefined();
  });

  it('asserts workflow_ref ends with the protected main path, mirroring postgres-image-publisher.yml', () => {
    const joined = (authorizeBlock ?? []).join('\n');
    expect(joined).toContain('*/.github/workflows/ci-image.yml@refs/heads/main');
  });

  it('asserts github.ref_protected is true', () => {
    const joined = (authorizeBlock ?? []).join('\n');
    expect(joined).toContain('REF_IS_PROTECTED');
    expect(joined).toContain("REF_IS_PROTECTED\" == 'true'");
  });

  it('every other job needs authorize-main, directly or transitively', () => {
    const blocks = jobBlocks(workflowSource);
    for (const [jobName, lines] of blocks) {
      if (jobName === 'authorize-main') continue;
      const needsLine = lines.find((line) => line.trim().startsWith('needs:'));
      expect(needsLine, `job ${jobName} has no needs: line`).toBeDefined();
      expect(needsLine, `job ${jobName} does not need authorize-main`).toContain('authorize-main');
    }
  });

  it('is never triggered by pull_request or push -- only schedule and workflow_dispatch', () => {
    const lines = withoutCommentLines(workflowSource);
    const onIndex = lines.findIndex((line) => line === 'on:');
    expect(onIndex).toBeGreaterThan(-1);
    const onBlock: string[] = [];
    for (const line of lines.slice(onIndex + 1)) {
      if (line.trim() && !line.startsWith(' ')) break;
      onBlock.push(line);
    }
    const triggers = onBlock.filter((line) => /^  [a-z_]+:/.test(line)).map((line) => line.trim().replace(':', ''));
    expect(triggers.sort()).toEqual(['schedule', 'workflow_dispatch']);
  });
});

describe('ci-image.yml: freeze-history builds against the right Dockerfile', () => {
  // Real bug caught while writing this workflow: `docker build` with no `-f`
  // looks for a file literally named `Dockerfile` in the context root. The
  // checkout's root has `Dockerfile.ci`, not `Dockerfile` -- omitting `-f`
  // here fails the build the moment a week actually needs freezing (i.e. not
  // on the day this ships, but the next time a week rolls over).
  it('passes -f Dockerfile.ci to the git-history build', () => {
    const block = jobBlocks(workflowSource).get('freeze-history') ?? [];
    const joined = block.join('\n');
    expect(joined).toContain('docker buildx build --target git-history -f Dockerfile.ci');
  });
});

describe('ci-image.yml: vp toolchain pairing for its own vp run step', () => {
  // Same invisible-pairing concern as ci-vp-toolchain.test.ts, scoped to this
  // new workflow: `vp run docker-context:ci` dies on `vp: command not found`
  // without voidzero-dev/setup-vp having run first in the same job.
  it('installs setup-vp before running `vp run docker-context:ci`', () => {
    const block = jobBlocks(workflowSource).get('build-daily-image') ?? [];
    const vpRunIndex = block.findIndex((line) => line.includes('vp run docker-context:ci'));
    const setupVpIndex = block.findIndex((line) => line.includes('voidzero-dev/setup-vp'));
    expect(vpRunIndex).toBeGreaterThan(-1);
    expect(setupVpIndex).toBeGreaterThan(-1);
    expect(setupVpIndex).toBeLessThan(vpRunIndex);
  });
});

describe('ci-image.yml: concurrency prevents overlapping runs', () => {
  it('has a single, non-cancelling concurrency group', () => {
    const lines = withoutCommentLines(workflowSource);
    const groupIndex = lines.findIndex((line) => line.trim() === 'group: ci-image');
    expect(groupIndex).toBeGreaterThan(-1);
    expect(lines.some((line) => line.trim() === 'cancel-in-progress: false')).toBe(true);
  });
});
