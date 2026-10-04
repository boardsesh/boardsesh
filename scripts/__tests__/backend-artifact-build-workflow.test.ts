import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
};
type BuildWorkflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if: string;
      'runs-on': string;
      environment?: unknown;
      permissions: Record<string, string>;
      concurrency?: { group: string; 'cancel-in-progress': boolean };
      env: Record<string, string>;
      steps: WorkflowStep[];
    }
  >;
};

const workflowText = readFileSync('.github/workflows/backend-artifact-build.yml', 'utf8');
const workflow = parse(workflowText) as BuildWorkflow;
const imageJob = workflow.jobs.image;

describe('backend artifact bootstrap isolation', () => {
  it('only builds the trusted main revision after a manual dispatch', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on.workflow_dispatch).toMatchObject({
      inputs: {
        mode: { type: 'choice', options: ['build', 'promote'], default: 'build' },
        artifact_digest: { type: 'string', default: '' },
        artifact_source_sha: { type: 'string', default: '' },
        expected_current_digest: { type: 'string', default: '' },
      },
    });
    expect(Object.keys(workflow.jobs)).toEqual(['image', 'promote']);
    expect(imageJob.if).toBe(
      "github.repository == 'boardsesh/boardsesh' && github.ref == 'refs/heads/main' && inputs.mode == 'build'",
    );
    expect(imageJob['runs-on']).toBe('ubuntu-latest');
    expect(imageJob.steps[0].with).toEqual({ ref: '${{ github.sha }}', 'persist-credentials': false });
    expect(workflow.permissions).toEqual({});
    expect(imageJob.permissions).toEqual({
      contents: 'read',
      packages: 'write',
      attestations: 'write',
      'id-token': 'write',
    });
  });

  it('has no production credentials or deployment steps and never updates a shared image tag', () => {
    expect(imageJob.environment).toBeUndefined();
    expect([...new Set(workflowText.match(/secrets\.[A-Z_]+/g))]).toEqual(['secrets.GITHUB_TOKEN']);
    expect(imageJob.steps.filter((step) => step.uses).map((step) => step.uses)).toEqual([
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
      'docker/login-action@dbcb813823bdd20940b903addbd779551569679f',
      'docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c',
      'docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a',
      'actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8',
    ]);
    const commandSteps = imageJob.steps.filter((step) => step.run);
    expect(commandSteps.map((step) => step.name)).toEqual([
      'Generate backend Docker context',
      'Record the artifact identity',
    ]);
    expect(commandSteps[0].run).toBe('node scripts/create-service-docker-context.mjs backend');
    expect(commandSteps[1].run).not.toMatch(/\b(?:gh|curl|railway|docker|vp|pnpm)\b/);
    expect(imageJob.env.IMAGE_NAME).toBe('ghcr.io/boardsesh/boardsesh-daemon');
    expect(imageJob.env.IMAGE_TAG).toBe(
      'r2-scheduler-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    const build = imageJob.steps.find((step) => step.name === 'Build and push the isolated backend artifact')!;
    expect(build.with?.tags).toBe('${{ env.IMAGE_NAME }}:${{ env.IMAGE_TAG }}');
    expect(build.with).not.toHaveProperty('cache-to');
  });

  it('uses the production daemon context and binds its release identity and attestation to this source', () => {
    const build = imageJob.steps.find((step) => step.name === 'Build and push the isolated backend artifact')!;
    expect(build.with).toMatchObject({
      context: '.docker-context/backend',
      file: '.docker-context/backend/Dockerfile',
      platforms: 'linux/amd64',
      push: true,
      'build-args': 'BOARDSESH_BUILD_RELEASE=${{ github.sha }}\n',
    });
    const attestation = imageJob.steps.find((step) => step.name === 'Generate artifact attestation')!;
    expect(attestation.with).toEqual({
      'subject-name': '${{ env.IMAGE_NAME }}',
      'subject-digest': '${{ steps.build.outputs.digest }}',
      'push-to-registry': true,
    });
    expect(imageJob.steps.indexOf(attestation)).toBeGreaterThan(imageJob.steps.indexOf(build));
  });
});

const promoteJob = workflow.jobs.promote;
const promoteStep = promoteJob.steps.find(
  (step) => step.name === 'Verify and promote only the accepted daemon digest',
)!;
const promotionScript = promoteStep.run!.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE\s*$/)![1];
const sourceSha = 'a'.repeat(40);
const dispatchedSha = 'd'.repeat(40);
const artifactDigest = `sha256:${'c'.repeat(64)}`;
const baselineDigest = `sha256:${'b'.repeat(64)}`;
type CommandCall = { command: string; args: string[] };

function runPromotion(
  scenario: Record<string, string | boolean | undefined> = {},
  overrides: Record<string, string | undefined> = {},
) {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'backend-promotion-test-'));
  const callsFile = join(fixtureDirectory, 'calls.jsonl');
  const fakeCommand = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const scenario = JSON.parse(process.env.SCENARIO);
fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify({ command, args }) + '\\n');
if (command === 'git') {
  if (args[0] === 'rev-parse') console.log(scenario.wrongCheckout ? 'e'.repeat(40) : process.env.GITHUB_SHA);
  else if (scenario.notAncestor) process.exit(1);
} else if (command === 'gh') {
  if (args[0] === 'attestation') {
    if (scenario.badAttestation) process.exit(1);
    console.log('verified');
  } else {
    if (scenario.apiFailure) process.exit(1);
    const apiPath = args[1];
    if (!apiPath.includes('/runs?')) console.log(JSON.stringify({ state: scenario.enabledPublisher ? 'active' : 'disabled_manually' }));
    else if (scenario.malformedRuns) console.log(JSON.stringify({ total_count: 0 }));
    else console.log(JSON.stringify({ total_count: apiPath.includes('status=' + scenario.liveStatus + '&') ? 101 : 0, workflow_runs: [] }));
  }
} else if (command === 'docker') {
  if (args[2] === 'create') {
    fs.writeFileSync(process.env.PROMOTED_FILE, 'promoted');
    if (scenario.committedBeforeError) process.exit(1);
  }
  else if (args[3].includes('@')) console.log(scenario.wrongArtifact ? process.env.EXPECTED_CURRENT_DIGEST : process.env.ARTIFACT_DIGEST);
  else if (fs.existsSync(process.env.PROMOTED_FILE)) console.log(scenario.wrongPostDigest ? process.env.EXPECTED_CURRENT_DIGEST : process.env.ARTIFACT_DIGEST);
  else console.log(scenario.changedBaseline ? 'sha256:' + 'e'.repeat(64) : process.env.EXPECTED_CURRENT_DIGEST);
} else process.exit(99);
`;
  for (const command of ['git', 'gh', 'docker'])
    writeFileSync(join(fixtureDirectory, command), fakeCommand, { mode: 0o700 });
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', promotionScript], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        PATH: `${fixtureDirectory}:${dirname(process.execPath)}`,
        SCENARIO: JSON.stringify(scenario),
        CALLS_FILE: callsFile,
        PROMOTED_FILE: join(fixtureDirectory, 'promoted'),
        GITHUB_STEP_SUMMARY: join(fixtureDirectory, 'summary'),
        MODE: 'promote',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REPOSITORY: 'boardsesh/boardsesh',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: dispatchedSha,
        ARTIFACT_DIGEST: artifactDigest,
        ARTIFACT_SOURCE_SHA: sourceSha,
        EXPECTED_CURRENT_DIGEST: baselineDigest,
        ...overrides,
      },
    });
    const calls = existsSync(callsFile)
      ? readFileSync(callsFile, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as CommandCall)
      : [];
    const summaryFile = join(fixtureDirectory, 'summary');
    return { result, calls, summary: existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : '' };
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
}

describe('manual backend digest promotion guards', () => {
  it('separates explicit promotion from building and acquires the normal deploy lock', () => {
    expect(promoteJob.if).toBe(
      "github.repository == 'boardsesh/boardsesh' && github.ref == 'refs/heads/main' && inputs.mode == 'promote'",
    );
    expect(promoteJob.concurrency).toEqual({ group: 'production-deploy', 'cancel-in-progress': false });
    expect(promoteJob.environment).toBeUndefined();
    expect(promoteJob.permissions).toEqual({
      contents: 'read',
      actions: 'read',
      packages: 'write',
      attestations: 'read',
    });
    expect(promoteJob.steps.filter((step) => step.run)).toEqual([promoteStep]);
    expect(promoteJob.steps.filter((step) => step.uses).map((step) => step.uses)).toEqual([
      'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
      'docker/login-action@dbcb813823bdd20940b903addbd779551569679f',
      'docker/setup-buildx-action@bb05f3f5519dd87d3ba754cc423b652a5edd6d2c',
    ]);
  });

  it('checks exact provenance, all 30 live-run totals, and the baseline before one canonical tag copy', () => {
    const { result, calls, summary } = runPromotion();
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContainEqual({ command: 'git', args: ['merge-base', '--is-ancestor', sourceSha, dispatchedSha] });
    const attestation = calls.find((call) => call.args[0] === 'attestation')!;
    expect(attestation.args).toEqual([
      'attestation',
      'verify',
      `oci://ghcr.io/boardsesh/boardsesh-daemon@${artifactDigest}`,
      '--repo',
      'boardsesh/boardsesh',
      '--signer-workflow',
      'boardsesh/boardsesh/.github/workflows/backend-artifact-build.yml',
      '--source-ref',
      'refs/heads/main',
      '--source-digest',
      sourceSha,
      '--deny-self-hosted-runners',
    ]);
    const drainedChecks = calls.filter((call) => call.args[0] === 'api' && call.args[1].includes('/runs?'));
    expect(drainedChecks).toHaveLength(30);
    expect(new Set(drainedChecks.map((call) => call.args[1])).size).toBe(30);
    const writes = calls.filter((call) => call.command === 'docker' && call.args[2] === 'create');
    expect(writes).toEqual([
      {
        command: 'docker',
        args: [
          'buildx',
          'imagetools',
          'create',
          '--prefer-index=false',
          '--tag',
          'ghcr.io/boardsesh/boardsesh-daemon:production',
          `ghcr.io/boardsesh/boardsesh-daemon@${artifactDigest}`,
        ],
      },
    ]);
    expect(calls.indexOf(writes[0])).toBeGreaterThan(calls.indexOf(attestation));
    expect(calls.slice(-1)[0].args).toContain('ghcr.io/boardsesh/boardsesh-daemon:production');
    expect(summary).toContain(baselineDigest);
    expect(summary).toContain('No Railway deployment or OTA publication');
  }, 35_000);

  it.each([
    { MODE: 'build' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_REPOSITORY: 'untrusted/fork' },
    { ARTIFACT_DIGEST: 'sha256:invalid' },
    { ARTIFACT_SOURCE_SHA: `${sourceSha}\nextra` },
    { EXPECTED_CURRENT_DIGEST: '' },
  ])('rejects malformed or untrusted dispatch inputs before external operations: %j', (overrides) => {
    const { result, calls } = runPromotion({}, overrides);
    expect(result.status).toBe(1);
    expect(calls).toEqual([]);
  });

  it.each([
    { wrongCheckout: true },
    { notAncestor: true },
    { badAttestation: true },
    { enabledPublisher: true },
    { apiFailure: true },
    { liveStatus: 'requested' },
    { liveStatus: 'waiting' },
    { liveStatus: 'pending' },
    { liveStatus: 'queued' },
    { liveStatus: 'in_progress' },
    { malformedRuns: true },
    { wrongArtifact: true },
    { changedBaseline: true },
  ])(
    'fails closed before any tag write when a promotion guard fails: %j',
    (scenario) => {
      const { result, calls } = runPromotion(scenario);
      expect(result.status).toBe(1);
      expect(calls.filter((call) => call.command === 'docker' && call.args[2] === 'create')).toEqual([]);
    },
    35_000,
  );

  it('fails after a mismatched post-promotion digest without guessing a rollback', () => {
    const { result, calls, summary } = runPromotion({ wrongPostDigest: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reconcile before deploying');
    expect(calls.filter((call) => call.command === 'docker' && call.args[2] === 'create')).toHaveLength(1);
    expect(summary).toContain(baselineDigest);
    expect(summary).not.toContain('Production tag verified.');
  }, 35_000);

  it('stops after an ambiguously committed tag write and retains the baseline for reconciliation', () => {
    const { result, calls, summary } = runPromotion({ committedBeforeError: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reconcile the production digest before retrying');
    expect(calls.filter((call) => call.command === 'docker' && call.args[2] === 'create')).toHaveLength(1);
    expect(summary).toContain(baselineDigest);
    expect(summary).not.toContain('Production tag verified.');
  }, 35_000);
});
