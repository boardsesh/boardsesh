import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyChangedFiles,
  determineProductionDeployChanges,
  formatGitHubOutputs,
  selectLatestSuccessfulPriorRun,
  summariseTargets,
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
    cloudflare: false,
    staticAssets: false,
  });
  assert.deepEqual(classifyChangedFiles(['packages/backend/src/index.ts']), {
    web: true,
    backend: true,
    app: false,
    cloudflare: false,
    staticAssets: false,
  });
  assert.deepEqual(classifyChangedFiles(['packages/mobile/app/index.tsx']), {
    web: false,
    backend: true,
    app: true,
    cloudflare: false,
    staticAssets: false,
  });
  assert.deepEqual(classifyChangedFiles(['packages/shared-schema/src/schema.ts']), {
    web: true,
    backend: true,
    app: true,
    cloudflare: false,
    staticAssets: false,
  });
  assert.deepEqual(classifyChangedFiles(['scripts/production-backend-smoke.mjs']), {
    web: false,
    backend: true,
    app: false,
    cloudflare: false,
    staticAssets: false,
  });
  assert.deepEqual(classifyChangedFiles(['scripts/production-backend-smoke.test.mjs']), {
    web: false,
    backend: false,
    app: false,
    cloudflare: false,
    staticAssets: false,
  });
});

void test('the deploy watchdog never queues a deploy of its own', () => {
  // It is a scheduled janitor for the concurrency group, not shipped code.
  for (const filePath of [
    '.github/workflows/production-deploy-watchdog.yml',
    'scripts/production-deploy-watchdog.mjs',
    'scripts/production-deploy-watchdog.test.mjs',
  ]) {
    assert.deepEqual(classifyChangedFiles([filePath]), {
      web: false,
      backend: false,
      app: false,
      cloudflare: false,
      staticAssets: false,
    });
  }
});

void test('a watchdog file alongside real code still deploys the real code', () => {
  // The skip is per-file, not per-changeset: a commit touching both must still
  // deploy what it changed, or the exclusion would swallow a real release.
  //
  // The backend path also sets web:true, which looks odd on its own. That is
  // isWebAffecting's pre-existing shape, not something this test introduces: it
  // is a denylist (mobile/, docs/, *.md and two scripts are excluded) so
  // anything else counts as web-affecting. www imports shared packages, so
  // erring toward a web deploy is the safe direction.
  assert.deepEqual(classifyChangedFiles(['scripts/production-deploy-watchdog.mjs', 'packages/backend/src/index.ts']), {
    web: true,
    backend: true,
    app: false,
    cloudflare: false,
    staticAssets: false,
  });
  assert.deepEqual(
    classifyChangedFiles(['.github/workflows/production-deploy-watchdog.yml', 'packages/mobile/app/index.tsx']),
    { web: false, backend: true, app: true, cloudflare: false, staticAssets: false },
  );
});

void test('treats the production workflow and its detector as affecting every target', () => {
  for (const filePath of ['.github/workflows/production-deploy.yml', 'scripts/production-deploy-changes.mjs']) {
    assert.deepEqual(classifyChangedFiles([filePath]), {
      web: true,
      backend: true,
      app: true,
      cloudflare: true,
      staticAssets: true,
    });
  }
});

void test('keeps production deploy unit tests CI-only', () => {
  for (const filePath of ['scripts/production-backend-smoke.test.mjs', 'scripts/production-deploy-changes.test.mjs']) {
    assert.deepEqual(classifyChangedFiles([filePath]), {
      web: false,
      backend: false,
      app: false,
      cloudflare: false,
      staticAssets: false,
    });
  }
});

void test('treats every input of the app.boardsesh.com export as app-affecting', () => {
  // The export recipe and the manifest patcher it shells out to both decide what
  // the subdomain serves, so a change to either has to fire deploy-app-web (and
  // with it the post-deploy manifest smoke). A patcher-only PR would otherwise
  // merge green, deploy nothing, and leave the author believing it shipped.
  // W-24 / #4438.
  for (const filePath of ['scripts/build-expo-web-export.sh', 'scripts/lib/patch-expo-web-pwa-manifest.mjs']) {
    assert.deepEqual(classifyChangedFiles([filePath]), {
      web: true,
      backend: false,
      app: true,
      cloudflare: false,
      staticAssets: false,
    });
  }

  for (const filePath of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json']) {
    assert.deepEqual(classifyChangedFiles([filePath]), {
      web: true,
      backend: true,
      app: true,
      cloudflare: false,
      staticAssets: false,
    });
  }

  assert.deepEqual(classifyChangedFiles(['patches/react-native-screens@4.26.2.patch']), {
    web: true,
    backend: false,
    app: true,
    cloudflare: false,
    staticAssets: false,
  });
});

void test('publishes cataloged static images but excludes retained board PNG sources', () => {
  assert.equal(classifyChangedFiles(['packages/web/public/images/kilter/wall.webp']).staticAssets, true);
  assert.equal(classifyChangedFiles(['packages/web/public/images/kilter/wall.png']).staticAssets, false);
  assert.equal(classifyChangedFiles(['packages/web/public/brand/boardsesh-mark.png']).staticAssets, true);
  assert.equal(classifyChangedFiles(['packages/web/app/favicon.ico']).staticAssets, true);
  assert.equal(classifyChangedFiles(['scripts/upload-static-assets.ts']).staticAssets, true);
});

void test('treats every deployed Cloudflare Pages config file as app-affecting', () => {
  // Same failure mode as the patcher above, one directory over. These four are
  // the only files deploy-app-web copies into (or beside) the export, and each
  // decides what app.boardsesh.com serves: the SPA fallback, the cache/security
  // headers, which paths reach the Function, and the Function itself. A change
  // to any of them that does not fire deploy-app-web merges green and ships
  // nothing — the asset-404 Function in particular would sit in the repo
  // looking deployed while a missing chunk kept serving the HTML shell.
  for (const filePath of [
    'deploy/app-subdomain/_headers',
    'deploy/app-subdomain/_redirects',
    'deploy/app-subdomain/_routes.json',
    'deploy/app-subdomain/functions/_middleware.ts',
  ]) {
    assert.deepEqual(classifyChangedFiles([filePath]), {
      web: true,
      backend: false,
      app: true,
      cloudflare: false,
      staticAssets: false,
    });
  }
});

void test('leaves the non-deployed files in deploy/app-subdomain out of the app deploy', () => {
  // The README, the tsconfig that only exists for type-aware lint, the vitest
  // project and its suites are never uploaded to Pages. Redeploying production
  // for a docs edit is pure noise, and treating the whole directory as
  // app-affecting is the easy mistake that causes it.
  for (const filePath of [
    'deploy/app-subdomain/README.md',
    'deploy/app-subdomain/tsconfig.json',
    'deploy/app-subdomain/vite.config.ts',
    'deploy/app-subdomain/__tests__/asset-404-middleware.test.ts',
  ]) {
    assert.equal(classifyChangedFiles([filePath]).app, false, `${filePath} must not trigger deploy-app-web`);
  }
});

void test('a Cloudflare zone-config change converges the edge without a web deploy', () => {
  // infra/cloudflare is desired edge state, not Next input: a cache rule or WAF
  // edit changes what Cloudflare does, and rebuilding www would prove nothing.
  // isWebAffecting is a denylist, so without the explicit exclusion every zone
  // edit would queue a full production web deploy for free.
  for (const filePath of [
    'infra/cloudflare/config.ts',
    'infra/cloudflare/plan.ts',
    'scripts/cloudflare-apply.ts',
    'scripts/cloudflare-apply.test.ts',
  ]) {
    assert.deepEqual(
      classifyChangedFiles([filePath]),
      { web: false, backend: false, app: false, cloudflare: true, staticAssets: false },
      `${filePath} must converge Cloudflare and nothing else`,
    );
  }
});

void test('a code change never drags the Cloudflare apply along with it', () => {
  // The converse guard. deploy-cloudflare talks to the live zone with a
  // production token; firing it on every packages/ commit would turn an
  // unrelated merge into an edge mutation.
  for (const filePath of ['packages/web/app/page.tsx', 'packages/backend/src/index.ts', 'pnpm-lock.yaml']) {
    assert.equal(classifyChangedFiles([filePath]).cloudflare, false, `${filePath} must not trigger deploy-cloudflare`);
  }
});

void test('keeps every backend build and runtime control path backend-affecting', () => {
  for (const filePath of [
    'Dockerfile.backend',
    'railway.toml',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
  ]) {
    const isRootInstallInput = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json'].includes(filePath);
    assert.deepEqual(classifyChangedFiles([filePath]), {
      web: true,
      backend: true,
      app: isRootInstallInput,
      cloudflare: false,
      staticAssets: false,
    });
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
    {
      web: result.web,
      backend: result.backend,
      app: result.app,
      cloudflare: result.cloudflare,
      fullBuild: result.fullBuild,
    },
    { web: true, backend: true, app: true, cloudflare: true, fullBuild: true },
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
  for (const unreachableSha of [BASE_SHA, HEAD_SHA]) {
    const checkedShas = [];
    const result = determineProductionDeployChanges({
      eventName: 'push',
      headSha: HEAD_SHA,
      runsPayload: runsPayload([successfulRun(20)]),
      git: {
        ...validGit(),
        commitExists(commitSha) {
          checkedShas.push(commitSha);
          return commitSha !== unreachableSha;
        },
      },
    });

    assert.deepEqual(checkedShas, unreachableSha === BASE_SHA ? [BASE_SHA] : [BASE_SHA, HEAD_SHA]);
    assert.equal(result.reason, 'unreachable-baseline-or-head');
    assert.equal(result.fullBuild, true);
  }
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
  assert.equal(
    formatGitHubOutputs(result),
    `web=true\nbackend=true\napp=false\ncloudflare=false\nstatic_assets=false\ndeployment_base_sha=${BASE_SHA}`,
  );
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

void test('the human-readable summary names every target the outputs do', () => {
  // These drifted once already: `cloudflare` was added to the GITHUB_OUTPUT
  // block but not to the log line, so the deploy log could not say whether the
  // Cloudflare apply had been targeted. Deriving one from the other makes that
  // impossible, and this pins it.
  const result = determineProductionDeployChanges({
    eventName: 'workflow_dispatch',
    headSha: '',
    runsPayload: null,
    git: null,
  });

  const summary = summariseTargets(result);
  for (const target of ['web', 'backend', 'app', 'cloudflare']) {
    assert.ok(summary.includes(`${target}=`), `summary must name ${target}: ${summary}`);
  }
  // And it must not leak the base sha, which the caller prints separately.
  assert.ok(!summary.includes('deployment_base_sha'), summary);
});
