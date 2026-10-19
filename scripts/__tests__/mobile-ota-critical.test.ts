import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CRITICAL_OTA_RELEASE_CHECKBOX } from '../../packages/shared/pr-body/src/ota-release';
import { detectCriticalOtaRelease } from '../mobile-ota-critical';
import { latestConsumedCriticalRelease } from '../lib/ota-critical-history';

const repository = 'boardsesh/boardsesh';
const criticalBody = `## OTA release\n\n${CRITICAL_OTA_RELEASE_CHECKBOX}`;
const scratchDirectories: string[] = [];

function scratchDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'critical-ota-'));
  scratchDirectories.push(directory);
  return directory;
}

function deploymentHistory() {
  const directory = scratchDirectory();
  const git = (argumentsList: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...argumentsList], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'OTA test',
        GIT_AUTHOR_EMAIL: 'ota-test@example.invalid',
        GIT_COMMITTER_NAME: 'OTA test',
        GIT_COMMITTER_EMAIL: 'ota-test@example.invalid',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git(['init', '--initial-branch=main']);
  const commit = (contents: string) => {
    writeFileSync(join(directory, 'change.txt'), contents);
    git(['add', 'change.txt']);
    git(['commit', '-m', contents]);
    return git(['rev-parse', 'HEAD']).trim();
  };
  const baseSha = commit('previous successful deploy');
  const supersededSha = commit('superseded main deployment');
  const headSha = commit('surviving main deployment');
  git(['update-ref', 'refs/remotes/origin/main', headSha]);
  return { directory, git, commit, baseSha, supersededSha, headSha };
}

function pull(number: number, mergeCommitSha: string, body = criticalBody) {
  return {
    number,
    merged: true,
    merge_commit_sha: mergeCommitSha,
    body,
    createdAt: '2026-10-18T00:00:00Z',
    lastEditedAt: null,
    mergedAt: '2026-10-19T00:00:00Z',
    base: { repo: { full_name: repository }, ref: 'main' },
  };
}

function githubFixture(responses: Record<string, unknown>) {
  const requests: string[] = [];
  return {
    requests,
    graphql: async (query: string) => {
      const pullNumber = /pullRequest\(number: (\d+)\)/.exec(query)?.[1];
      const endpoint = pullEndpoint(Number(pullNumber));
      requests.push(endpoint);
      const snapshot = responses[endpoint] as ReturnType<typeof pull> | undefined;
      if (!snapshot) throw new Error(`Unexpected pull request query: ${query}`);
      return {
        data: {
          repository: {
            pullRequest: {
              ...snapshot,
              mergeCommit: { oid: snapshot.merge_commit_sha },
              baseRepository: { nameWithOwner: snapshot.base.repo.full_name },
              baseRefName: snapshot.base.ref,
            },
          },
        },
      };
    },
    github: async (endpoint: string) => {
      requests.push(endpoint);
      if (Object.hasOwn(responses, endpoint)) return responses[endpoint];
      if (/\/commits\/[a-f0-9]{40}\/pulls\?per_page=100&page=1$/.test(endpoint)) return [];
      throw new Error(`Unexpected GitHub request: ${endpoint}`);
    },
  };
}

const associatedEndpoint = (commitSha: string, page = 1) =>
  `repos/${repository}/commits/${commitSha}/pulls?per_page=100&page=${page}`;
const pullEndpoint = (number: number) => `repos/${repository}/pulls/${number}`;

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('critical OTA deployment detection', () => {
  it('inherits a verified critical merge from a superseded main push in the real cumulative range', async () => {
    const history = deploymentHistory();
    const criticalPull = pull(101, history.supersededSha);
    const normalPull = pull(
      102,
      history.headSha,
      '## OTA release\n- [ ] Critical OTA release: roll out to 100% stable immediately',
    );
    const github = githubFixture({
      [associatedEndpoint(history.supersededSha)]: [criticalPull],
      [pullEndpoint(101)]: criticalPull,
      [associatedEndpoint(history.headSha)]: [normalPull],
      [pullEndpoint(102)]: normalPull,
    });
    const decision = await detectCriticalOtaRelease({
      ...history,
      ...github,
      repository,
      deploymentBaseSha: history.baseSha,
    });
    expect(decision).toEqual({ critical: true, pullNumbers: [101], inspectedCommits: 2, headOnlyFallback: false });
    expect(github.requests).not.toContain(associatedEndpoint(history.baseSha));
  });

  it.each(['success', 'failure', 'cancelled', 'timed_out'])(
    'returns later PRs to normal cadence after a critical attempt ended %s',
    async (criticalConclusion) => {
      const history = deploymentHistory();
      const criticalPull = pull(101, history.supersededSha);
      const github = githubFixture({
        [associatedEndpoint(history.supersededSha)]: [criticalPull],
        [pullEndpoint(101)]: criticalPull,
      });
      const criticalConsumptionSha = await latestConsumedCriticalRelease({
        ...history,
        repository,
        deploymentBaseSha: history.baseSha,
        currentRunId: '30',
        github: async (endpoint) =>
          endpoint.includes('/attempts/1/jobs')
            ? {
                total_count: 1,
                jobs: [
                  {
                    id: 2500,
                    run_id: 25,
                    run_attempt: 1,
                    head_sha: history.supersededSha,
                    run_url: `https://api.github.com/repos/${repository}/actions/runs/25`,
                    name: 'promote-mobile-ota',
                    status: 'completed',
                    conclusion: 'failure',
                    steps: [
                      {
                        name: 'Release critical staged bytes to 100% stable',
                        status: 'completed',
                        conclusion: criticalConclusion,
                      },
                    ],
                  },
                ],
              }
            : {
                workflow_runs: [
                  {
                    id: 25,
                    run_attempt: 1,
                    path: '.github/workflows/production-deploy.yml',
                    head_sha: history.supersededSha,
                    head_branch: 'main',
                    repository: { full_name: repository },
                    head_repository: { full_name: repository },
                    event: 'push',
                    status: 'completed',
                    conclusion: 'failure',
                  },
                ],
              },
      });
      const decision = await detectCriticalOtaRelease({
        ...history,
        ...github,
        repository,
        deploymentBaseSha: history.baseSha,
        criticalConsumptionSha,
      });
      expect(decision).toEqual({ critical: false, pullNumbers: [], inspectedCommits: 1, headOnlyFallback: false });
      expect(github.requests).toEqual([associatedEndpoint(history.headSha)]);
      const freshCriticalPull = pull(102, history.headSha);
      const freshGithub = githubFixture({
        [associatedEndpoint(history.headSha)]: [freshCriticalPull],
        [pullEndpoint(102)]: freshCriticalPull,
      });
      const recovery = await detectCriticalOtaRelease({
        ...history,
        ...freshGithub,
        repository,
        deploymentBaseSha: history.baseSha,
        criticalConsumptionSha,
      });
      expect(recovery.pullNumbers).toEqual([102]);
    },
  );

  it('does not replay a consumed publication when redispatching the same HEAD without a deployment baseline', async () => {
    const history = deploymentHistory();
    const github = githubFixture({});
    expect(
      await detectCriticalOtaRelease({
        ...history,
        ...github,
        repository,
        deploymentBaseSha: '',
        criticalConsumptionSha: history.headSha,
      }),
    ).toEqual({ critical: false, pullNumbers: [], inspectedCommits: 0, headOnlyFallback: false });
    expect(github.requests).toEqual([]);
  });

  it('allows a fresh critical merge after a previously consumed publication', async () => {
    const history = deploymentHistory();
    const criticalPull = pull(102, history.headSha);
    const github = githubFixture({
      [associatedEndpoint(history.headSha)]: [criticalPull],
      [pullEndpoint(102)]: criticalPull,
    });
    expect(
      (
        await detectCriticalOtaRelease({
          ...history,
          ...github,
          repository,
          deploymentBaseSha: history.baseSha,
          criticalConsumptionSha: history.supersededSha,
        })
      ).pullNumbers,
    ).toEqual([102]);
  });

  it('ignores unmerged, wrong-repository, wrong-target and non-merge commit associations', async () => {
    const history = deploymentHistory();
    const unmerged = { ...pull(1, history.headSha), merged: false };
    const foreign = { ...pull(2, history.headSha), base: { repo: { full_name: 'other/repo' }, ref: 'main' } };
    const wrongTarget = { ...pull(3, history.headSha), base: { repo: { full_name: repository }, ref: 'release' } };
    const headAssociation = pull(4, history.supersededSha);
    const github = githubFixture({
      [associatedEndpoint(history.headSha)]: [unmerged, foreign, wrongTarget, headAssociation],
      [pullEndpoint(1)]: unmerged,
    });
    const decision = await detectCriticalOtaRelease({
      ...history,
      ...github,
      repository,
      deploymentBaseSha: history.supersededSha,
    });
    expect(decision.critical).toBe(false);
    expect(github.requests).toEqual([associatedEndpoint(history.headSha), pullEndpoint(1)]);
  });

  it.each(['2026-10-19T00:00:00Z', '2026-10-19T00:00:01Z'])(
    'cannot authorize an urgent release from a body edited at %s after merge',
    async (lastEditedAt) => {
      const history = deploymentHistory();
      const criticalPull = { ...pull(101, history.headSha), lastEditedAt };
      const github = githubFixture({
        [associatedEndpoint(history.headSha)]: [criticalPull],
        [pullEndpoint(101)]: criticalPull,
      });
      const decision = await detectCriticalOtaRelease({
        ...history,
        ...github,
        repository,
        deploymentBaseSha: history.supersededSha,
      });
      expect(decision.critical).toBe(false);
    },
  );

  it('accepts a checkbox edited before merge from the same atomic GraphQL snapshot', async () => {
    const history = deploymentHistory();
    const criticalPull = { ...pull(101, history.headSha), lastEditedAt: '2026-10-18T23:59:59Z' };
    const github = githubFixture({
      [associatedEndpoint(history.headSha)]: [criticalPull],
      [pullEndpoint(101)]: criticalPull,
    });
    expect(
      (
        await detectCriticalOtaRelease({
          ...history,
          ...github,
          repository,
          deploymentBaseSha: history.supersededSha,
        })
      ).critical,
    ).toBe(true);
  });

  it('rejects incomplete GraphQL results and missing authorization timestamps', async () => {
    const history = deploymentHistory();
    const criticalPull = pull(101, history.headSha);
    const github = githubFixture({
      [associatedEndpoint(history.headSha)]: [criticalPull],
      [pullEndpoint(101)]: { ...criticalPull, mergedAt: undefined },
    });
    const options = { ...history, ...github, repository, deploymentBaseSha: history.supersededSha };
    await expect(detectCriticalOtaRelease(options)).rejects.toThrow('authorization existed before merge');
    await expect(
      detectCriticalOtaRelease({
        ...options,
        graphql: async () => ({ errors: [{ message: 'Resource inaccessible' }], data: {} }),
      }),
    ).rejects.toThrow('Incomplete merged pull request');
  });

  it('checks HEAD only when no safe baseline exists without replaying historical critical merges', async () => {
    const history = deploymentHistory();
    const github = githubFixture({
      [associatedEndpoint(history.supersededSha)]: [pull(1, history.supersededSha)],
    });
    const decision = await detectCriticalOtaRelease({
      ...history,
      ...github,
      repository,
      deploymentBaseSha: '',
    });
    expect(decision).toEqual({ critical: false, pullNumbers: [], inspectedCommits: 1, headOnlyFallback: true });
    expect(github.requests).toEqual([associatedEndpoint(history.headSha)]);
  });

  it('rejects an untrusted checkout or incomplete non-first-parent baseline', async () => {
    const history = deploymentHistory();
    const github = githubFixture({});
    await expect(
      detectCriticalOtaRelease({
        ...history,
        ...github,
        repository,
        headSha: history.supersededSha,
        deploymentBaseSha: history.baseSha,
      }),
    ).rejects.toThrow('Checkout differs');
    history.git(['checkout', '-b', 'topic', history.baseSha]);
    const sideSha = history.commit('side branch commit');
    history.git(['checkout', 'main']);
    history.git(['merge', '--no-ff', 'topic', '-s', 'ours', '-m', 'merge topic']);
    const mergedHead = history.git(['rev-parse', 'HEAD']).trim();
    history.git(['update-ref', 'refs/remotes/origin/main', mergedHead]);
    await expect(
      detectCriticalOtaRelease({ ...history, ...github, repository, headSha: mergedHead, deploymentBaseSha: sideSha }),
    ).rejects.toThrow('complete first-parent deployment range');
    expect(github.requests).toEqual([]);
  });

  it('fails closed on API failures and malformed verification payloads', async () => {
    const history = deploymentHistory();
    const options = { ...history, ...githubFixture({}), repository, deploymentBaseSha: history.supersededSha };
    await expect(
      detectCriticalOtaRelease({
        ...options,
        github: async () => {
          throw new Error('GitHub unavailable');
        },
      }),
    ).rejects.toThrow('GitHub unavailable');
    await expect(
      detectCriticalOtaRelease({ ...options, github: async () => ({ message: 'rate limited' }) }),
    ).rejects.toThrow('Malformed associated');
    const github = githubFixture({
      [associatedEndpoint(history.headSha)]: [pull(1, history.headSha)],
      [pullEndpoint(1)]: { ...pull(1, history.headSha), merged: undefined },
    });
    await expect(detectCriticalOtaRelease({ ...options, ...github })).rejects.toThrow('Malformed merged');
  });

  it('bounds commit scanning and refuses truncated associated-PR pagination', async () => {
    const history = deploymentHistory();
    await expect(
      detectCriticalOtaRelease({
        ...history,
        ...githubFixture({}),
        repository,
        deploymentBaseSha: history.baseSha,
        github: async () => [],
        git: (argumentsList) =>
          argumentsList[0] === 'rev-list' ? `${history.headSha}\n`.repeat(101) : history.git(argumentsList),
      }),
    ).rejects.toThrow('exceeds 100 commits');
    const associated = Array.from({ length: 100 }, (_, index) => pull(index + 1, history.baseSha));
    const github = githubFixture({
      [associatedEndpoint(history.headSha, 1)]: associated,
      [associatedEndpoint(history.headSha, 2)]: associated,
      [associatedEndpoint(history.headSha, 3)]: associated,
    });
    await expect(
      detectCriticalOtaRelease({ ...history, ...github, repository, deploymentBaseSha: history.supersededSha }),
    ).rejects.toThrow('truncated');
    expect(github.requests).toHaveLength(3);
  });
});

interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  'continue-on-error'?: boolean;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface WorkflowJob {
  if?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
  environment?: string;
  concurrency?: Record<string, unknown>;
}
const workflow = parse(
  readFileSync(resolve(import.meta.dirname, '../../.github/workflows/production-deploy.yml'), 'utf8'),
) as { jobs: Record<string, WorkflowJob> };

describe('critical OTA production workflow', () => {
  it('runs dependency-free detection with only read permissions before exposing its decision', () => {
    const detect = workflow.jobs['detect-changes'];
    expect(detect.permissions).toEqual({ actions: 'read', contents: 'read', 'pull-requests': 'read' });
    expect(detect.outputs?.critical_ota).toBe('${{ steps.critical-ota.outputs.critical_ota }}');
    expect(detect.outputs?.ota_changed).toBe(
      "${{ steps.critical-ota.outputs.critical_ota == 'true' && 'true' || steps.changes.outputs.ota }}",
    );
    const steps = detect.steps ?? [];
    const detectorIndex = steps.findIndex((step) => step.id === 'critical-ota');
    const nodeIndex = steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(nodeIndex).toBeGreaterThan(-1);
    expect(nodeIndex).toBeLessThan(detectorIndex);
    expect(steps[nodeIndex].with?.['node-version']).toBe('22.x');
    expect(steps[detectorIndex].env).toEqual({
      GH_TOKEN: '${{ github.token }}',
      DEPLOYMENT_BASE_SHA: '${{ steps.changes.outputs.deployment_base_sha }}',
    });
    expect(steps[detectorIndex].run).toBe('node --experimental-strip-types scripts/mobile-ota-critical.ts');
    expect(steps.some((step) => /\b(?:install|vp|pnpm|npm)\b/.test(step.run ?? ''))).toBe(false);
  });

  it('routes critical merges to production independently of automatic stable activation', () => {
    const promote = workflow.jobs['promote-mobile-ota'];
    expect(promote.if).toContain("needs.detect-changes.result == 'success'");
    expect(promote.if).toContain(
      "vars.OTA_STABLE_RELEASE_ENABLED != 'true' || needs.detect-changes.outputs.critical_ota == 'true'",
    );
    expect(promote.if).toContain("needs.stage-mobile-ota.result == 'success'");
    const template = readFileSync(resolve(import.meta.dirname, '../../.github/pull_request_template.md'), 'utf8');
    expect(template).toContain(`## OTA release\n`);
    expect(template).toContain(CRITICAL_OTA_RELEASE_CHECKBOX.replace('[x]', '[ ]'));
    const report = promote.steps?.find((step) => step.name === 'Report promoted OTA');
    expect(report?.env?.CRITICAL_OTA).toBe('${{ needs.detect-changes.outputs.critical_ota }}');
    expect(report?.run).toContain('production (critical, 100% stable)');
  });

  it('restores authoritative controller ownership inside the production lock before critical publication', () => {
    const promote = workflow.jobs['promote-mobile-ota'];
    const steps = promote.steps ?? [];
    const restore = steps.find((step) => step.id === 'critical-state');
    const release = steps.find((step) => step.id === 'critical-promote');
    expect(promote.concurrency).toEqual({
      group: 'mobile-ota-production',
      'cancel-in-progress': false,
      queue: 'max',
    });
    expect(promote.environment).toBe(
      "${{ needs.detect-changes.outputs.critical_ota == 'true' && 'ota-stable-release' || 'Production' }}",
    );
    expect(restore?.if).toBe("needs.detect-changes.outputs.critical_ota == 'true'");
    expect(restore?.env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(restore?.run).toContain('scripts/mobile-ota-stable-artifacts.ts state');
    expect(restore?.run).toContain('--exclude-run-id "$GITHUB_RUN_ID" --production-locked');
    expect(restore?.run).toContain('echo "loaded_run=$(jq -r');
    expect(release?.if).toBe("needs.detect-changes.outputs.critical_ota == 'true'");
    expect(release?.env).toMatchObject({
      OTA_ADMIN_EMAIL: '${{ secrets.OTA_ADMIN_EMAIL }}',
      OTA_ADMIN_PASSWORD: '${{ secrets.OTA_ADMIN_PASSWORD }}',
      EOO_TOKEN: '${{ secrets.EOO_TOKEN }}',
      LOADED_STATE_RUN_ID: '${{ steps.critical-state.outputs.loaded_run }}',
    });
    expect(release?.run).toContain('scripts/mobile-ota-critical-promote.ts');
    expect(release?.run).toContain('--source-sha "$GITHUB_SHA" --state controller-state/state.json');
    expect(release?.run).toContain('--loaded-state-run-id "$LOADED_STATE_RUN_ID"');
    const prerequisites = [
      steps.findIndex((step) => step.uses?.startsWith('actions/download-artifact@')),
      steps.findIndex((step) => step.name === 'Require live backend schema'),
      steps.findIndex((step) => step.name === 'Wait for the OTA server rollout on this commit'),
      steps.findIndex((step) => step.id === 'critical-state'),
    ];
    const releaseIndex = steps.findIndex((step) => step.id === 'critical-promote');
    for (const prerequisite of prerequisites) {
      expect(prerequisite).toBeGreaterThan(-1);
      expect(prerequisite).toBeLessThan(releaseIndex);
    }
  });

  it('isolates critical publication from the generic promoter and Production-only changelog credentials', () => {
    const steps = workflow.jobs['promote-mobile-ota'].steps ?? [];
    const retryGuard = steps.find((step) => step.name === 'Refuse blind critical promotion retries');
    expect(retryGuard?.if).toBe("needs.detect-changes.outputs.critical_ota == 'true' && github.run_attempt != 1");
    expect(retryGuard?.run).toBe('exit 1');
    expect(steps.indexOf(retryGuard!)).toBeLessThan(steps.findIndex((step) => step.id === 'critical-promote'));
    const legacyPromotion = steps.find((step) => step.id === 'promote');
    expect(legacyPromotion?.if).toBe("needs.detect-changes.outputs.critical_ota != 'true'");
    expect(legacyPromotion?.run).toContain('scripts/mobile-ota-promote.ts');
    expect(legacyPromotion?.env?.OTA_ADMIN_PASSWORD).toBeUndefined();
    const mintToken = steps.find((step) => step.id === 'push_token');
    expect(mintToken?.if).toContain("needs.detect-changes.outputs.critical_ota != 'true'");
    const changelogPush = steps.find((step) => step.name === 'Push promoted changelog to main');
    expect(changelogPush?.if).toContain("steps.promote.outcome == 'success'");
    expect(changelogPush?.if).not.toContain('critical-promote');
    for (const name of ['OTA health check (non-blocking)', 'Report promoted OTA']) {
      const reporting = steps.find((step) => step.name === name);
      expect(reporting?.if).toContain("steps.critical-promote.outcome == 'success'");
      expect(reporting?.if).toContain("steps.promote.outcome == 'success'");
    }
    expect(steps.find((step) => step.id === 'health')?.['continue-on-error']).toBe(true);
  });

  it('retains original receipt and critical proof for thirty days after success or partial failure', () => {
    const steps = workflow.jobs['promote-mobile-ota'].steps ?? [];
    const evidence = steps.find((step) => step.name === 'Retain critical supersession evidence');
    expect(evidence?.if).toBe(
      "always() && needs.detect-changes.outputs.critical_ota == 'true' && steps.critical-promote.outcome != 'skipped'",
    );
    expect(evidence?.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(evidence?.with?.name).toBe('critical-ota-release-evidence');
    expect(String(evidence?.with?.path).trim().split('\n')).toEqual([
      'ota-stage/receipt.json',
      'ota-stage/critical-supersession.json',
      'ota-stage/critical-receipt.json',
    ]);
    expect(evidence?.with?.['retention-days']).toBe(30);
    expect(evidence?.with?.['if-no-files-found']).toBe('error');
    expect(steps.findIndex((step) => step.id === 'critical-promote')).toBeLessThan(steps.indexOf(evidence!));
  });

  it('requires production publication for critical merges while normal daily releases remain staged', () => {
    const verification = workflow.jobs['verify-mobile-ota'].steps?.find(
      (step) => step.name === 'Require both staging and promotion',
    );
    expect(verification?.env?.CRITICAL_OTA).toBe('${{ needs.detect-changes.outputs.critical_ota }}');
    for (const [enabled, critical, promotion, passes] of [
      ['true', 'false', 'skipped', true],
      ['true', 'true', 'success', true],
      ['true', 'true', 'skipped', false],
      ['false', 'false', 'success', true],
    ] as const) {
      const execution = spawnSync('bash', ['-e', '-c', verification?.run ?? 'exit 99'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          STAGE_RESULT: 'success',
          EARLY_RESULT: 'success',
          PROMOTE_RESULT: promotion,
          DAILY_ENABLED: enabled,
          CRITICAL_OTA: critical,
        },
      });
      expect(execution.status === 0, `${enabled}/${critical}/${promotion}: ${execution.stdout}`).toBe(passes);
    }
  });
});
