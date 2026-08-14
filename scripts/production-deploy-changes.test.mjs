import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyChangedFiles,
  determineProductionDeployChanges,
  formatGitHubOutputs,
  selectLatestSuccessfulPriorRun,
} from './production-deploy-changes.mjs';

const BASE_SHA = '1111111111111111111111111111111111111111';
const HEAD_SHA = '2222222222222222222222222222222222222222';

function runsPayload(workflowRuns) {
  return { workflow_runs: workflowRuns };
}

function successfulRun(id, headSha = BASE_SHA) {
  return { id, status: 'completed', conclusion: 'success', head_sha: headSha };
}

function validGit(changedFiles = []) {
  return {
    commitExists: () => true,
    isAncestor: () => true,
    changedFiles: () => changedFiles,
  };
}

void test('selects the first successful prior run from GitHub newest-first results', () => {
  const selected = selectLatestSuccessfulPriorRun(
    runsPayload([
      { id: 30, conclusion: null, head_sha: HEAD_SHA },
      { id: 29, conclusion: 'failure', head_sha: '3333333333333333333333333333333333333333' },
      successfulRun(28),
      successfulRun(27, '4444444444444444444444444444444444444444'),
    ]),
    { currentRunId: '30' },
  );

  assert.equal(selected?.id, 28);
  assert.equal(selected?.head_sha, BASE_SHA);
});

void test('excludes the current run ID while allowing a prior successful run at the same SHA', () => {
  const selected = selectLatestSuccessfulPriorRun(
    runsPayload([successfulRun(42, HEAD_SHA), successfulRun(41, HEAD_SHA)]),
    { currentRunId: '42' },
  );

  assert.equal(selected?.id, 41);
  assert.equal(selected?.head_sha, HEAD_SHA);
});

void test('ignores incomplete runs and malformed head SHAs from the Actions response', () => {
  const selected = selectLatestSuccessfulPriorRun(
    runsPayload([
      { ...successfulRun(44), status: 'in_progress' },
      successfulRun(43, `${BASE_SHA}\nbackend=true`),
      successfulRun(42),
    ]),
  );

  assert.equal(selected?.id, 42);
  assert.equal(selected?.head_sha, BASE_SHA);
});

void test('classifies changed paths with the production workflow semantics', () => {
  assert.deepEqual(classifyChangedFiles(['docs/deployments.md']), {
    web: false,
    backend: false,
    app: false,
  });
  assert.deepEqual(classifyChangedFiles(['packages/backend/src/index.ts']), {
    web: true,
    backend: true,
    app: false,
  });
  assert.deepEqual(classifyChangedFiles(['packages/mobile/app/index.tsx']), {
    web: false,
    backend: true,
    app: true,
  });
  assert.deepEqual(classifyChangedFiles(['packages/shared-schema/src/schema.ts']), {
    web: true,
    backend: true,
    app: true,
  });
  assert.deepEqual(classifyChangedFiles(['scripts/production-backend-smoke.mjs']), {
    web: true,
    backend: true,
    app: false,
  });
  assert.deepEqual(classifyChangedFiles(['scripts/production-backend-smoke.test.mjs']), {
    web: true,
    backend: false,
    app: false,
  });
});

void test('treats the production workflow and its detector as affecting every target', () => {
  for (const filePath of [
    '.github/workflows/production-deploy.yml',
    'scripts/production-deploy-changes.mjs',
    'scripts/production-deploy-changes.test.mjs',
  ]) {
    assert.deepEqual(classifyChangedFiles([filePath]), { web: true, backend: true, app: true });
  }
});

void test('manual dispatch builds every target without consulting history or git', () => {
  const result = determineProductionDeployChanges({
    eventName: 'workflow_dispatch',
    headSha: '',
    runsPayload: null,
    git: null,
  });

  assert.deepEqual(
    { web: result.web, backend: result.backend, app: result.app, fullBuild: result.fullBuild },
    { web: true, backend: true, app: true, fullBuild: true },
  );
  assert.equal(result.reason, 'workflow_dispatch');
});

void test('missing or malformed Actions history falls back to a full build', () => {
  for (const payload of [null, {}, { workflow_runs: 'not-an-array' }, runsPayload([])]) {
    const result = determineProductionDeployChanges({
      eventName: 'push',
      headSha: HEAD_SHA,
      runsPayload: payload,
      git: validGit(),
    });
    assert.equal(result.fullBuild, true);
    assert.deepEqual([result.web, result.backend, result.app], [true, true, true]);
  }
});

void test('an invalid current head SHA falls back without writing it as the deployment baseline', () => {
  const result = determineProductionDeployChanges({
    eventName: 'push',
    headSha: `${HEAD_SHA}\napp=true`,
    runsPayload: runsPayload([successfulRun(20)]),
    git: validGit(),
  });

  assert.equal(result.reason, 'missing-or-invalid-head-sha');
  assert.equal(result.deploymentBaseSha, '');
  assert.deepEqual([result.web, result.backend, result.app], [true, true, true]);
});

void test('an unreachable baseline or head falls back to a full build', () => {
  const checkedShas = [];
  const result = determineProductionDeployChanges({
    eventName: 'push',
    headSha: HEAD_SHA,
    runsPayload: runsPayload([successfulRun(20)]),
    git: {
      ...validGit(),
      commitExists(commitSha) {
        checkedShas.push(commitSha);
        return commitSha !== BASE_SHA;
      },
    },
  });

  assert.deepEqual(checkedShas, [BASE_SHA]);
  assert.equal(result.reason, 'unreachable-baseline-or-head');
  assert.equal(result.fullBuild, true);
});

void test('a baseline outside the current history falls back to a full build', () => {
  const result = determineProductionDeployChanges({
    eventName: 'push',
    headSha: HEAD_SHA,
    runsPayload: runsPayload([successfulRun(20)]),
    git: { ...validGit(), isAncestor: () => false },
  });

  assert.equal(result.reason, 'baseline-is-not-an-ancestor');
  assert.deepEqual([result.web, result.backend, result.app], [true, true, true]);
});

void test('compares the successful deployment baseline through the current head', () => {
  const calls = [];
  const result = determineProductionDeployChanges({
    eventName: 'push',
    headSha: HEAD_SHA,
    currentRunId: '21',
    runsPayload: runsPayload([successfulRun(20)]),
    git: {
      commitExists(commitSha) {
        calls.push(['exists', commitSha]);
        return true;
      },
      isAncestor(baseSha, headSha) {
        calls.push(['ancestor', baseSha, headSha]);
        return true;
      },
      changedFiles(baseSha, headSha) {
        calls.push(['diff', baseSha, headSha]);
        return ['packages/backend/src/index.ts'];
      },
    },
  });

  assert.equal(result.deploymentBaseSha, BASE_SHA);
  assert.equal(result.fullBuild, false);
  assert.deepEqual([result.web, result.backend, result.app], [true, true, false]);
  assert.deepEqual(calls, [
    ['exists', BASE_SHA],
    ['exists', HEAD_SHA],
    ['ancestor', BASE_SHA, HEAD_SHA],
    ['diff', BASE_SHA, HEAD_SHA],
  ]);
  assert.equal(formatGitHubOutputs(result), `web=true\nbackend=true\napp=false\ndeployment_base_sha=${BASE_SHA}`);
});

void test('a git comparison error falls back to a full build', () => {
  const result = determineProductionDeployChanges({
    eventName: 'push',
    headSha: HEAD_SHA,
    runsPayload: runsPayload([successfulRun(20)]),
    git: {
      ...validGit(),
      changedFiles() {
        throw new Error('git diff failed');
      },
    },
  });

  assert.equal(result.fullBuild, true);
  assert.deepEqual([result.web, result.backend, result.app], [true, true, true]);
});
