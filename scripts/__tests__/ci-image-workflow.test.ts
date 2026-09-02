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

  it('has exactly three FROM instructions: seed-base, git-history, ci-image', () => {
    const stageNames = [...dockerfileSource.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gm)].map((match) => match[1]);
    expect(stageNames).toEqual(['seed-base', 'git-history', 'ci-image']);
  });
});

describe('Dockerfile.ci: manifests feed pnpm fetch, never the other way round', () => {
  it('copies every manifest input before RUN pnpm fetch', () => {
    const fetchIndex = dockerfileSource.indexOf('RUN pnpm fetch');
    expect(fetchIndex).toBeGreaterThan(-1);

    // Matched by manifest path rather than whole-line, so adding a flag
    // (--chown, --link) stays legal while MOVING a manifest below the fetch
    // -- the thing that would silently un-cache the store layer -- still
    // fails.
    for (const manifestPath of [
      'manifests/package.json',
      'manifests/pnpm-lock.yaml',
      'manifests/pnpm-workspace.yaml',
      'manifests/packages',
      'manifests/patches',
    ]) {
      const copyIndex = dockerfileSource.indexOf(manifestPath);
      expect(copyIndex, `missing COPY of ${manifestPath}`).toBeGreaterThan(-1);
      expect(copyIndex, `${manifestPath} must be copied before pnpm fetch`).toBeLessThan(fetchIndex);
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

  it('never copies real workspace source -- a job brings its own via actions/checkout', () => {
    // The sibling Dockerfiles copy `source/packages` after their install
    // layer; Dockerfile.ci must never do the equivalent. A job checks out
    // its own ref, so baked source would be both redundant and a stale
    // shadow of what the job is actually testing.
    expect(dockerfileSource).not.toMatch(/^COPY source\//m);
    expect(dockerfileSource).not.toMatch(/^COPY packages\//m);
  });
});

describe('Dockerfile.ci: the image is runnable, not a data blob', () => {
  // The whole reason this image carries a runner agent: the fleet RUNS it,
  // one job per container, and `--rm` is what resets the machine between
  // jobs. Regress any of these and the image silently reverts to something
  // a host has to unpack, taking the per-job reset with it.
  const codeLines = dockerfileLines();

  it('declares an ENTRYPOINT so `docker run <image>` serves a job', () => {
    expect(codeLines.some((line) => /^ENTRYPOINT\s/.test(line))).toBe(true);
  });

  it('installs the actions/runner agent with a pinned version AND checksum', () => {
    // Unpinned, this layer is the one thing every job's code passes through
    // and a rebuild could silently change it.
    expect(codeLines.some((line) => /^ARG RUNNER_VERSION=\d+\.\d+\.\d+$/.test(line))).toBe(true);
    expect(codeLines.some((line) => /^ARG RUNNER_SHA256=[0-9a-f]{64}$/.test(line))).toBe(true);
    expect(codeLines.some((line) => line.includes('sha256sum -c -'))).toBe(true);
  });

  it('runs jobs as a non-root user -- the agent refuses to start as root', () => {
    const lastUserLine = [...codeLines].reverse().find((line) => /^USER\s/.test(line));
    expect(lastUserLine).toBe('USER runner');
  });

  it('wires the job-started hook, without which the baked git store is inert', () => {
    // The seed only pays off if a fresh checkout is pointed at it before
    // actions/checkout runs. Drop this and every job silently goes back to a
    // cold ~400 MB clone while the image still looks correct.
    expect(codeLines.some((line) => line.startsWith('ENV ACTIONS_RUNNER_HOOK_JOB_STARTED='))).toBe(true);
    expect(dockerfileSource).toMatch(/COPY --from=ciscripts[^\n]*job-started\.sh/);
  });

  it('keeps the runner agent OUT of the frozen history chain', () => {
    // Position 4 in the header's layer order. If the agent install moved up
    // into seed-base it would be shared by every frozen `week-<date>` tag,
    // so GitHub's next forced agent upgrade would demand an out-of-cycle
    // re-baseline of 342 MB of git history that did not change.
    const seedBaseStart = codeLines.findIndex((line) => /^FROM .* AS seed-base$/.test(line));
    const ciImageStart = codeLines.findIndex((line) => /^FROM .* AS ci-image$/.test(line));
    const runnerVersionIndex = codeLines.findIndex((line) => line.startsWith('ARG RUNNER_VERSION='));

    expect(seedBaseStart).toBeGreaterThan(-1);
    expect(ciImageStart).toBeGreaterThan(seedBaseStart);
    expect(runnerVersionIndex).toBeGreaterThan(ciImageStart);
  });

  it('adds the pnpm store AFTER the toolchain, so a daily rebuild reuses it', () => {
    const runnerVersionIndex = codeLines.findIndex((line) => line.startsWith('ARG RUNNER_VERSION='));
    const fetchIndex = codeLines.findIndex((line) => line.includes('pnpm fetch'));
    const currentPackIndex = codeLines.findIndex((line) => line.startsWith('ARG CURRENT_PACK_NAME='));

    expect(runnerVersionIndex).toBeLessThan(fetchIndex);
    expect(fetchIndex).toBeLessThan(currentPackIndex);
  });
});

describe('Dockerfile.ci: the hosted tool cache is prefilled', () => {
  // setup-node/setup-python re-download their toolchain on EVERY job unless
  // the tool cache has the exact layout AND the sibling `.complete` marker --
  // the marker is what the actions test for, not the directory.
  //
  // Python additionally cannot come from apt, for two independent reasons:
  // setup-python only downloads Ubuntu builds and this image is Debian (so the
  // lookup fails outright), and Debian's system Python is PEP 668
  // externally-managed so `pip install` fails against it. Issue #5050.
  const codeLines = dockerfileLines();

  it('prefills Node with its .complete marker', () => {
    expect(dockerfileSource).toMatch(/hostedtoolcache\/node\/\$\{node_version#v\}\/x64\.complete/);
  });

  it('installs Python from actions/python-versions, not apt', () => {
    expect(dockerfileSource).toMatch(/COPY --from=ciscripts[^\n]*install-python\.sh/);
    expect(codeLines.some((line) => line.includes('/usr/local/bin/install-python.sh'))).toBe(true);
    // An apt Python would be found by neither setup-python nor pip. Checked
    // per code line rather than with a regex over the apt block, because that
    // block is line-continued and `[^\n]*` cannot cross the continuations.
    expect(codeLines.filter((line) => line.includes('python3-pip'))).toEqual([]);
  });

  it('pins the Python versions so a rebuild cannot change the interpreter', () => {
    const pinned = codeLines.find((line) => line.startsWith('ARG PYTHON_VERSIONS='));
    expect(pinned, 'ARG PYTHON_VERSIONS= not found').toBeDefined();
    // Every entry must be a full x.y.z, not a floating '3.11'.
    const versions = (pinned as string)
      .replace(/^ARG PYTHON_VERSIONS=/, '')
      .replace(/"/g, '')
      .trim()
      .split(/\s+/);
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(version, `${version} is not a pinned patch release`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('chowns the tool cache to the job user AFTER Python lands in it', () => {
    // Jobs run as `runner`. A chown that ran before the Python install would
    // leave it root-owned, and setup-python would fail to use it.
    const pythonIndex = codeLines.findIndex((line) => line.includes('install-python.sh') && line.startsWith('RUN'));
    const chownIndex = codeLines.findIndex((line) => /^RUN chown -R runner:runner \/opt\/hostedtoolcache$/.test(line));
    expect(pythonIndex).toBeGreaterThan(-1);
    expect(chownIndex).toBeGreaterThan(pythonIndex);
  });
});

describe('Dockerfile.ci: every pack layer names its tip as a ref', () => {
  // The bug this pins was found by running the image, not by reading it.
  // `git fetch` negotiation is driven by the fetching repo's REFS: a seed
  // with every object but no refs makes a job advertise "I have nothing", so
  // the server sends a full pack and the entire git half of the seed is
  // silently inert -- while the image still looks completely correct. Only a
  // timing measurement would ever have caught it.
  const codeLines = dockerfileLines();

  it('records a ref for the frozen history pack', () => {
    expect(codeLines.some((line) => /^ARG PACK_TIP$/.test(line))).toBe(true);
    expect(dockerfileSource).toMatch(/update-ref "refs\/ci-seed\/\$\{PACK_NAME\}" "\$\{PACK_TIP\}"/);
  });

  it('records a ref for the current week pack', () => {
    expect(codeLines.some((line) => /^ARG CURRENT_PACK_TIP$/.test(line))).toBe(true);
    expect(dockerfileSource).toMatch(/update-ref "refs\/ci-seed\/\$\{CURRENT_PACK_NAME\}" "\$\{CURRENT_PACK_TIP\}"/);
  });

  it('has ci-image.yml supply both tips', () => {
    expect(workflowSource).toMatch(/--build-arg "PACK_TIP=/);
    expect(workflowSource).toMatch(/--build-arg "CURRENT_PACK_TIP=/);
  });
});

describe('docker/ci/job-started.sh: seeds refs, not just the alternate', () => {
  const hookSource = readFileSync('docker/ci/job-started.sh', 'utf8');
  const hookCodeLines = withoutCommentLines(hookSource);

  it('writes the alternate', () => {
    expect(hookCodeLines.some((line) => line.includes('objects/info/alternates'))).toBe(true);
  });

  it('installs the seed refs -- the half that actually saves the download', () => {
    expect(hookCodeLines.some((line) => line.includes('for-each-ref'))).toBe(true);
    expect(hookCodeLines.some((line) => line.includes('update-ref'))).toBe(true);
  });

  it('never exits non-zero -- a failing hook fails the job before it starts', () => {
    // Every failure path must degrade to a cold clone, never to a red job.
    const explicitExits = [...hookSource.matchAll(/^\s*exit\s+(\d+)/gm)].map((match) => match[1]);
    expect(explicitExits.length).toBeGreaterThan(0);
    expect(explicitExits.every((code) => code === '0')).toBe(true);
    // `set -e` would turn any unchecked command into exactly that failure.
    expect(hookCodeLines.some((line) => /^set -[a-z]*e/.test(line.trim()))).toBe(false);
  });
});

describe('ci-image.yml: the current-week pack is checked before it is baked', () => {
  // A published build failed with "trying to write ref refs/ci-seed/current-week
  // with nonexistent object", several Docker layers deep, saying nothing about
  // which input was wrong. The pack is generated from $tip while the exclude
  // boundary was resolved against `main` -- which keeps moving as PRs merge
  // during the build -- so the exclude could stop being an ancestor of $tip and
  // strip the very commit the pack exists for.

  it('reads the exclude boundary from the base image, never re-derives it', () => {
    // Re-deriving from a date is the bug: the newest frozen layer is
    // `week-<today>` while commits are still landing on that date, so the
    // derived boundary drifts away from what the layer was actually frozen to
    // (observed: 41b73995e frozen vs 1c4546409 re-derived). The layer records
    // its own tip as refs/ci-seed/<tag>, which cannot drift.
    const packStep = workflowSource.slice(
      workflowSource.indexOf("Generate the current week's pack"),
      workflowSource.indexOf('Build and push the daily image'),
    );
    expect(packStep).not.toMatch(/resolve-tip/);
    expect(packStep).toMatch(/rev-parse "refs\/ci-seed\/\$\{HISTORY_BASE\}"/);
  });

  it('fails loudly if the exclude tip is not an ancestor of the pack tip', () => {
    expect(workflowSource).toMatch(/git merge-base --is-ancestor "\$exclude_tip" "\$tip"/);
  });

  it('fails loudly if the pack does not contain its own tip', () => {
    expect(workflowSource).toMatch(/git verify-pack[^\n]*current-week\.idx/);
  });

  it('does not check that with `grep -q`, which false-positives under pipefail', () => {
    // The step runs `set -Eeuo pipefail`. `grep -q` exits the moment it
    // matches, git verify-pack dies of SIGPIPE, and pipefail turns that into a
    // failed pipeline -- so the check fires exactly when the tip IS present.
    // It shipped that way and failed a build whose pack was perfectly fine.
    const packStep = workflowSource.slice(
      workflowSource.indexOf("Generate the current week's pack"),
      workflowSource.indexOf('Build and push the daily image'),
    );
    expect(packStep).not.toMatch(/verify-pack[\s\S]{0,200}?grep -q/);
    expect(packStep).toMatch(/verify-pack[\s\S]{0,200}?grep -c/);
  });
});

describe('ci-image.yml: the daily build passes every named context Dockerfile.ci reads', () => {
  // A missing --build-context fails the build outright, but only at the line
  // that reads it -- after the expensive layers. Cheaper to catch here.
  it('passes each COPY --from=<context> a matching --build-context', () => {
    const namedContexts = new Set(
      [...dockerfileSource.matchAll(/^COPY --from=([a-z][a-z0-9-]*)/gm)].map((match) => match[1]),
    );
    // Stage names are legitimate COPY --from= targets too; only the named
    // build contexts need a flag.
    const stageNames = new Set([...dockerfileSource.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gm)].map((match) => match[1]));

    for (const contextName of namedContexts) {
      if (stageNames.has(contextName)) continue;
      expect(workflowSource, `--build-context ${contextName}= missing from ci-image.yml`).toMatch(
        new RegExp(`--build-context "${contextName}=`),
      );
    }
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
