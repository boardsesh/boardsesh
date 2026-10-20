import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { resolveBranchDeploySource } from '../resolve-branch-deploy-source.mjs';

const repository = 'boardsesh/boardsesh';
const currentSha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 314,
    state: 'open',
    base: { repo: { full_name: repository } },
    head: { sha: currentSha, ref: 'spoofable-branch-name', repo: { full_name: repository } },
    ...overrides,
  };
}

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function workflowDispatch() {
  return { inputs: { pr_number: '314' } };
}

describe('branch deploy source resolution', () => {
  it('builds the selected PR head, not the workflow_dispatch ref or PR branch name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(pullRequest()));

    await expect(
      resolveBranchDeploySource({
        eventName: 'workflow_dispatch',
        eventPayload: workflowDispatch(),
        repository,
        token: 'test-token',
        fetchImpl,
      }),
    ).resolves.toEqual({ number: 314, sourceSha: currentSha });

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://api.github.com/repos/boardsesh/boardsesh/pulls/314'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    );
  });

  it.each([
    ['missing selected PR', null, 404, /lookup failed/],
    ['closed selected PR', pullRequest({ state: 'closed' }), 200, /not open/],
    ['different PR number', pullRequest({ number: 315 }), 200, /different PR number/],
    [
      'foreign base repo',
      pullRequest({ base: { repo: { full_name: 'attacker/boardsesh' } } }),
      200,
      /targets a different repository/,
    ],
    [
      'fork head',
      pullRequest({ head: { sha: currentSha, repo: { full_name: 'contributor/boardsesh' } } }),
      200,
      /same-repository/,
    ],
    [
      'invalid head SHA',
      pullRequest({ head: { sha: 'main', repo: { full_name: repository } } }),
      200,
      /valid immutable head SHA/,
    ],
  ])('fails closed for %s', async (_name, body, status, message) => {
    await expect(
      resolveBranchDeploySource({
        eventName: 'workflow_dispatch',
        eventPayload: workflowDispatch(),
        repository,
        token: 'test-token',
        fetchImpl: vi.fn().mockResolvedValue(response(body, status)),
      }),
    ).rejects.toThrow(message);
  });

  it('rejects a pull_request event when GitHub head advanced after the event payload', async () => {
    const eventPayload = {
      number: 314,
      pull_request: { head: { sha: otherSha, repo: { full_name: repository } } },
    };

    await expect(
      resolveBranchDeploySource({
        eventName: 'pull_request',
        eventPayload,
        repository,
        token: 'test-token',
        fetchImpl: vi.fn().mockResolvedValue(response(pullRequest())),
      }),
    ).rejects.toThrow(/event head no longer matches/);
  });

  it('rejects unsupported events and malformed PR inputs before making an API call', async () => {
    const fetchImpl = vi.fn();
    await expect(
      resolveBranchDeploySource({
        eventName: 'workflow_dispatch',
        eventPayload: { inputs: { pr_number: '314; echo unsafe' } },
        repository,
        token: 'test-token',
        fetchImpl,
      }),
    ).rejects.toThrow(/positive numeric/);
    await expect(
      resolveBranchDeploySource({
        eventName: 'push',
        eventPayload: {},
        repository,
        token: 'test-token',
        fetchImpl,
      }),
    ).rejects.toThrow(/unsupported/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('branch deploy workflow source and serving gates', () => {
  const workflow = parse(readFileSync('.github/workflows/branch-deploy.yml', 'utf8')) as {
    on?: Record<string, unknown>;
    jobs: Record<
      string,
      {
        needs?: string[];
        outputs?: Record<string, string>;
        env?: Record<string, string>;
        steps: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }>;
      }
    >;
  };

  it('keeps automatic PR triggers disabled and uses only the pinned Vite+ toolchain', () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(['workflow_dispatch']);
    const build = workflow.jobs['build-images'];
    expect(build.steps.some((step) => step.uses?.startsWith('voidzero-dev/setup-vp@v1'))).toBe(true);
    expect(build.steps.some((step) => step.run === 'vp install --frozen-lockfile')).toBe(true);
    expect(build.steps.some((step) => step.run === 'vp run mobile:web-runtime:install')).toBe(true);
    expect(readFileSync('.github/workflows/branch-deploy.yml', 'utf8')).not.toMatch(/setup-bun|bun install/);
  });

  it('resolves the requested PR before builds and makes invalid resolution block publishing and deployment', () => {
    const detect = workflow.jobs['detect-changes'];
    const resolveIndex = detect.steps.findIndex((step) => step.name === 'Resolve selected PR source');
    const detectIndex = detect.steps.findIndex((step) => step.name === 'Detect changed paths');
    expect(resolveIndex).toBeGreaterThanOrEqual(0);
    expect(detectIndex).toBeGreaterThan(resolveIndex);
    expect(detect.steps[resolveIndex].run).toContain('scripts/resolve-branch-deploy-source.mjs');
    expect(detect.outputs?.source_sha).toContain('steps.source.outputs.source_sha');
    expect(workflow.jobs['build-images'].needs).toContain('detect-changes');
    expect(workflow.jobs.deploy.needs).toContain('build-images');
  });

  it('checks out and labels every image with the resolved PR SHA', () => {
    const build = workflow.jobs['build-images'];
    const checkout = build.steps.find((step) => step.uses === 'actions/checkout@v6');
    const imageBuilds = build.steps.filter((step) => step.uses === 'docker/build-push-action@v7');
    expect(checkout?.with?.ref).toBe('${{ needs.detect-changes.outputs.source_sha }}');
    expect(imageBuilds).toHaveLength(3);
    for (const step of imageBuilds) {
      expect(step.with?.labels).toContain('${{ needs.detect-changes.outputs.source_sha }}');
    }
    expect(imageBuilds[0].with?.['build-args']).toContain(
      'BOARDSESH_BUILD_RELEASE=${{ needs.detect-changes.outputs.source_sha }}',
    );
    expect(imageBuilds[1].with?.['build-args']).toContain(
      'BOARDSESH_BUILD_RELEASE=${{ needs.detect-changes.outputs.source_sha }}',
    );
  });

  it('uses the resolved SHA for deployment tracking and verifies images before replacing containers', () => {
    const createDeployment = workflow.jobs['create-deployment'];
    expect(createDeployment.needs).toContain('detect-changes');
    expect(createDeployment.env?.SOURCE_SHA).toBe('${{ needs.detect-changes.outputs.source_sha }}');
    const create = createDeployment.steps.find((step) => step.name === 'Create deployment');
    expect(create?.run).toContain('--arg ref "$SOURCE_SHA"');

    const deploy = workflow.jobs.deploy;
    const verify = deploy.steps.findIndex(
      (step) => step.name === 'Pull and verify images match the selected PR source',
    );
    const replace = deploy.steps.findIndex((step) => step.name === 'Deploy preview containers');
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(replace).toBeGreaterThan(verify);
    expect(deploy.steps[verify].run).toContain('org.opencontainers.image.revision');
  });

  it('waits for a bounded successful Caddy root response before publishing preview URLs', () => {
    const deploy = workflow.jobs.deploy;
    const healthIndex = deploy.steps.findIndex((step) => step.name === 'Wait for app preview to serve');
    const summaryIndex = deploy.steps.findIndex((step) => step.name === 'Publish preview URLs to job summary');
    const health = deploy.steps[healthIndex].run ?? '';
    expect(healthIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeGreaterThan(healthIndex);
    expect(health).toContain('APP_HEALTH_CHECK_ATTEMPTS');
    expect(health).toContain('docker inspect');
    expect(health).toContain('RestartCount');
    expect(health).toContain('docker exec');
    expect(health).toContain('http://127.0.0.1/');
    expect(health).toContain('exit 1');
  });

  it.each([
    ['running Caddy returns HTTP 200', 'running false 0', 'success', 0, 'serves HTTP 200'],
    ['missing app times out', '', 'missing', 1, 'timed out after 60s waiting'],
    ['exited app fails immediately', 'exited false 0', 'success', 1, 'entered exited'],
    ['restart loop fails immediately', 'running true 3', 'success', 1, 'entered running'],
    ['root request failure times out', 'running false 0', 'failure', 1, 'timed out after 60s waiting'],
  ])('executes the app readiness gate when %s', (_name, inspectState, httpResult, expectedStatus, expectedText) => {
    const healthStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Wait for app preview to serve');
    const healthScript = healthStep?.run;
    expect(healthScript).toBeDefined();

    const tempDirectory = mkdtempSync(join(tmpdir(), 'branch-deploy-health-'));
    const dockerStub = join(tempDirectory, 'docker');
    writeFileSync(
      dockerStub,
      `#!/usr/bin/env bash\nset -eu\ncase "$1" in\n  inspect)\n    if [ "${inspectState}" = missing ]; then exit 1; fi\n    printf '%s\\n' "${inspectState}"\n    ;;\n  exec)\n    [ "${httpResult}" = success ]\n    ;;\n  logs|ps) exit 0 ;;\n  *) echo "unexpected docker invocation: $*" >&2; exit 90 ;;\nesac\n`,
      'utf8',
    );
    chmodSync(dockerStub, 0o755);

    try {
      const result = spawnSync('/bin/bash', ['-c', healthScript!], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          APP_HEALTH_CHECK_ATTEMPTS: '2',
          APP_HEALTH_POLL_SECONDS: '0.01',
          PATH: `${tempDirectory}:${process.env.PATH ?? ''}`,
          PR_NUM: '314',
        },
      });
      expect(result.status).toBe(expectedStatus);
      expect(`${result.stdout}\n${result.stderr}`).toContain(expectedText);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it('keeps the serving smoke test local, loopback-only, and scoped to its own fixture', () => {
    const smoke = readFileSync('scripts/test-app-preview-serving.sh', 'utf8');
    const curlCommands = smoke.split('\n').filter((line) => /^\s*curl\b/.test(line));
    expect(smoke).toContain('docker image inspect caddy:2-alpine');
    expect(smoke).toContain('this smoke test never pulls images');
    expect(smoke).toContain('CADDY_BASE_REPO_DIGEST');
    expect(smoke).toContain('FROM $CADDY_BASE_REPO_DIGEST');
    expect(smoke).toContain('--publish 127.0.0.1::80');
    expect(smoke).toContain('docker port "$CONTAINER_ID" 80/tcp');
    expect(smoke).toContain('^127\\.0\\.0\\.1:([0-9]+)$');
    expect(curlCommands.length).toBeGreaterThan(0);
    expect(curlCommands.every((line) => line.includes('--connect-timeout') && line.includes('--max-time'))).toBe(true);
    expect(smoke).not.toContain('--mount');
    expect(smoke).toContain('--read-only');
    expect(smoke).toContain('--connect-timeout 1 --max-time 5');
    expect(smoke).toContain('CONTAINER_CREATED=1');
    expect(smoke).toContain('IMAGE_CREATED=1');
    expect(smoke).toContain('docker rm -f "$CONTAINER_ID"');
    expect(smoke).toContain('docker image rm "$IMAGE"');
    expect(smoke).toContain('rm -rf -- "$TMP_ROOT"');
    expect(smoke).toContain('cmp "$TMP_ROOT/context/app-standalone$JS_PATH" "$TMP_ROOT/served-smoke.js"');
    expect(smoke).toContain('cmp "$TMP_ROOT/context/app-standalone$WASM_PATH" "$TMP_ROOT/served-smoke.wasm"');
    expect(smoke).not.toMatch(/docker\s+(system|container|image)\s+prune/);
    expect(smoke).not.toContain('ghcr.io/');
    expect(smoke).toContain('wasm/smoke.wasm Content-Type');
    expect(smoke).toContain('Cache-Control');
  });
});
