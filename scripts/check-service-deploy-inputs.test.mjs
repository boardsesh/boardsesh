import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createServiceDeployInputFailures } from './check-service-deploy-inputs.mjs';

const PINNED_PNPM_VERSION = '11.22.0';

function writeFixtureFile(repoRoot, relativePath, contents) {
  const absolutePath = join(repoRoot, relativePath);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf8');
}

function writePackage(repoRoot, directory, packageJson) {
  writeFixtureFile(repoRoot, `${directory}/package.json`, `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFixtureFile(repoRoot, `${directory}/src/index.ts`, 'export {};\n');
}

function writeRootPackageJson(repoRoot, overrides = {}) {
  writeFixtureFile(
    repoRoot,
    'package.json',
    `${JSON.stringify({ packageManager: `pnpm@${PINNED_PNPM_VERSION}`, ...overrides }, null, 2)}\n`,
  );
}

function writeWorkspaceYaml(repoRoot, { packages = ['packages/*', 'packages/shared/*'], patchedDependencies } = {}) {
  const lines = ['packages:'];
  for (const workspacePattern of packages) lines.push(`  - '${workspacePattern}'`);
  lines.push('', 'nodeLinker: isolated');
  if (patchedDependencies) {
    lines.push('', 'patchedDependencies:');
    for (const [dependency, patchPath] of Object.entries(patchedDependencies)) {
      lines.push(`  '${dependency}': ${patchPath}`);
    }
  }
  writeFixtureFile(repoRoot, 'pnpm-workspace.yaml', `${lines.join('\n')}\n`);
}

function writeVercelJson(repoRoot, pnpmVersion = PINNED_PNPM_VERSION) {
  writeFixtureFile(
    repoRoot,
    'packages/web/vercel.json',
    `${JSON.stringify(
      {
        installCommand: `npx --yes pnpm@${pnpmVersion} install --frozen-lockfile`,
        buildCommand: `npx --yes pnpm@${pnpmVersion} --filter=@boardsesh/web run build`,
        framework: 'nextjs',
      },
      null,
      2,
    )}\n`,
  );
}

function dockerfileLines(extraLines = []) {
  return [
    'FROM node:22-alpine',
    `RUN npm install --global --no-fund --no-audit pnpm@${PINNED_PNPM_VERSION}`,
    'COPY manifests/package.json manifests/pnpm-lock.yaml manifests/pnpm-workspace.yaml ./',
    // extraLines is where callers put the patches COPY, which the real
    // Dockerfiles keep above the fetch — patch hashes are resolved from the
    // lockfile, so the files have to be there before it runs.
    ...extraLines,
    'RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \\',
    '    pnpm fetch',
    // AFTER the fetch, mirroring the real Dockerfiles: the fetch layer must key
    // on the lockfile alone, not on all 49 workspace manifests.
    'COPY manifests/packages ./packages',
    'RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \\',
    '    pnpm install --frozen-lockfile --offline',
    'COPY source/packages ./packages',
    '',
  ].join('\n');
}

function createFixtureRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'boardsesh-service-check-fixture-'));
  writeRootPackageJson(repoRoot);
  writeWorkspaceYaml(repoRoot);
  writeFixtureFile(repoRoot, 'pnpm-lock.yaml', "lockfileVersion: '10.0'\n");
  writeFixtureFile(repoRoot, '.dockerignore', '**/node_modules\n**/dist\n.docker-context\n');
  writeFixtureFile(repoRoot, 'railway.toml', '[deploy]\nstartCommand = "echo ok"\n');
  writeFixtureFile(repoRoot, 'railway.web.toml', '[deploy]\nhealthcheckPath = "/api/health"\n');
  // Declared as extraSourceFiles entries on the web service; context
  // generation fails when one is missing, so the fixture repo carries stubs.
  writeFixtureFile(repoRoot, 'scripts/build-expo-web-export.sh', '#!/usr/bin/env bash\n');
  writeFixtureFile(repoRoot, 'scripts/lib/patch-expo-web-pwa-manifest.mjs', 'export {};\n');
  writeFixtureFile(repoRoot, 'scripts/lib/tailscale-hostname.ts', 'export {};\n');
  // Same for the backend service's extraSourceDirs entry.
  writeFixtureFile(repoRoot, 'packages/web/public/images/stub.webp', '');

  writePackage(repoRoot, 'packages/backend', {
    name: 'boardsesh-backend',
    dependencies: { '@boardsesh/shared-lib': 'workspace:*' },
    devDependencies: { '@boardsesh/dev-only': 'workspace:*' },
  });
  writePackage(repoRoot, 'packages/web', {
    name: '@boardsesh/web',
    dependencies: { '@boardsesh/ui-lib': 'workspace:*' },
  });
  writeVercelJson(repoRoot);
  writePackage(repoRoot, 'packages/mobile', { name: '@boardsesh/mobile' });
  writePackage(repoRoot, 'packages/new-workspace', { name: '@boardsesh/new-workspace' });
  writePackage(repoRoot, 'packages/shared/shared-lib', { name: '@boardsesh/shared-lib' });
  writePackage(repoRoot, 'packages/shared/ui-lib', { name: '@boardsesh/ui-lib' });
  writePackage(repoRoot, 'packages/shared/dev-only', { name: '@boardsesh/dev-only' });
  writePackage(repoRoot, 'packages/kilter-sync', { name: '@boardsesh/kilter-sync' });
  writePackage(repoRoot, 'packages/aurora-sync', { name: '@boardsesh/aurora-sync' });
  writePackage(repoRoot, 'packages/moonboard-sync', { name: '@boardsesh/moonboard-sync' });
  // The `sync` service roots from the scheduler too (it rides the same image),
  // and the base fixture writes Dockerfile.sync — so every fixture test
  // generates the sync context and needs this workspace to exist.
  writePackage(repoRoot, 'packages/scheduler', { name: '@boardsesh/scheduler' });

  writeFixtureFile(repoRoot, 'Dockerfile.backend', dockerfileLines());
  writeFixtureFile(repoRoot, 'Dockerfile.web', dockerfileLines());
  writeFixtureFile(repoRoot, 'Dockerfile.sync', dockerfileLines());
  writeFixtureFile(repoRoot, 'packages/db/docker/Dockerfile.dev-db', dockerfileLines());

  writeFixtureFile(
    repoRoot,
    '.github/workflows/branch-deploy.yml',
    [
      'run: case "$file" in packages/*|Dockerfile.backend|scripts/create-service-docker-context.mjs|pnpm-lock.yaml|pnpm-workspace.yaml|package.json)',
      'run: vp run docker-context:web',
      'context: .docker-context/web',
      'file: .docker-context/web/Dockerfile',
      'run: vp run docker-context:backend',
      'context: .docker-context/backend',
      'file: .docker-context/backend/Dockerfile',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    repoRoot,
    '.github/workflows/production-deploy.yml',
    [
      'concurrency:',
      '  group: production-deploy',
      '  cancel-in-progress: false',
      'permissions:',
      '  actions: read',
      'outputs:',
      '  deployment_base_sha: example',
      '  static_assets_changed: example',
      'BEFORE_SHA: ${{ needs.detect-changes.outputs.deployment_base_sha }}',
      'run: node scripts/production-deploy-changes.mjs --runs-json "$RUNS_JSON"',
      'run: vp run upload:static-assets',
      "needs.sync-static-assets.result == 'success' || needs.sync-static-assets.result == 'skipped'",
      'SYNC_STATIC_ASSETS: ${{ needs.sync-static-assets.result }}',
      'run: node scripts/create-service-docker-context.mjs backend',
      'context: .docker-context/backend',
      'file: .docker-context/backend/Dockerfile',
      'run: node scripts/create-service-docker-context.mjs web',
      'context: .docker-context/web',
      'file: .docker-context/web/Dockerfile',
      'uses: ./.github/actions/railway-redeploy',
      'uses: ./.github/actions/railway-rollback',
      'target-deployment-id: ${{ steps.railway-redeploy.outputs.previous_deployment_id }}',
      'expected-current-deployment-id: ${{ steps.railway-redeploy.outputs.deployment_id }}',
      'uses: ./.github/actions/railway-rollback',
      'target-deployment-id: ${{ steps.railway-redeploy.outputs.previous_deployment_id }}',
      'expected-current-deployment-id: ${{ steps.railway-redeploy.outputs.deployment_id }}',
      'node scripts/production-backend-smoke.mjs',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    repoRoot,
    '.github/actions/railway-redeploy/action.yml',
    [
      'inputs:',
      '  expected-image:',
      '    required: true',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - run: curl railway-v4.66.0-x86_64-unknown-linux-gnu.tar.gz',
      '    - run: echo 31ca04094bee7cb4eaf7a14e0d856dae3cf4ee6c8b2b8354e652968c5d20abfe',
      '    - run: printf digest | sha256sum --check --strict',
      '    - run: timeout 30s railway deployment list',
      '    - run: node scripts/railway-deployment-status.mjs capture-previous railway-before.json',
      '    - run: echo NORMALIZED_RAILWAY_SERVICE_ID="${RAILWAY_SERVICE_ID,,}"',
      '    - run: echo RAILWAY_SERVICE_ID: ${{ steps.railway-validate.outputs.service_id }}',
      '    - run: echo ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$.',
      '    - run: timeout 60s railway redeploy --from-source --json > "$RAILWAY_STATE_DIR/trigger.json"',
      '    - run: node scripts/railway-deployment-status.mjs find-new railway-deployments.json',
      '    - run: echo "deployment_id=$LOCKED_DEPLOYMENT_ID" >> "$GITHUB_OUTPUT"',
      '    - run: if [ "$SUCCESS_CONFIRMATIONS" -ge 3 ]; then',
      '    - uses: ./.github/actions/railway-rollback',
      '      expected-current-deployment-id: ${{ steps.railway-wait.outputs.deployment_id }}',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    repoRoot,
    '.github/actions/railway-rollback/action.yml',
    [
      'inputs:',
      '  service-id:',
      '    required: true',
      '  railway-token:',
      '    required: true',
      '  target-deployment-id:',
      '    required: true',
      '  expected-current-deployment-id:',
      '    required: true',
      'outputs:',
      '  rollback_deployment_id:',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - env:',
      '        RAILWAY_SERVICE_ID: ${{ inputs.service-id }}',
      '        RAILWAY_TOKEN: ${{ inputs.railway-token }}',
      '        TARGET_DEPLOYMENT_ID: ${{ inputs.target-deployment-id }}',
      '        EXPECTED_CURRENT_DEPLOYMENT_ID: ${{ inputs.expected-current-deployment-id }}',
      '      run: node scripts/railway-deployment-rollback.mjs',
      '',
    ].join('\n'),
  );
  writeFixtureFile(
    repoRoot,
    'scripts/railway-deployment-rollback.mjs',
    [
      "const header = 'Project-Access-Token';",
      "const query = 'deployment(id: $id)';",
      "const mutation = 'deploymentRollback(id: $id)';",
      'const canRollback = true;',
      'const signal = AbortSignal.timeout(30000);',
      '',
    ].join('\n'),
  );
  writeFixtureFile(repoRoot, 'scripts/railway-deployment-rollback.test.mjs', '');
  writeFixtureFile(repoRoot, '.github/workflows/e2e-tests.yml', 'find packages -type d -name dist -prune\n');

  return repoRoot;
}

function withFixtureRepo(callback) {
  const repoRoot = createFixtureRepo();
  try {
    callback(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

void test('passes for generated Docker context inputs, including newly added workspaces', () => {
  withFixtureRepo((repoRoot) => {
    assert.deepEqual(createServiceDeployInputFailures({ repoRoot }), []);
  });
});

void test('requires every Docker image to install the root packageManager pnpm version', () => {
  withFixtureRepo((repoRoot) => {
    for (const dockerfilePath of [
      'Dockerfile.backend',
      'Dockerfile.web',
      'Dockerfile.sync',
      'packages/db/docker/Dockerfile.dev-db',
    ]) {
      const originalDockerfile = readFileSync(join(repoRoot, dockerfilePath), 'utf8');
      writeFixtureFile(repoRoot, dockerfilePath, originalDockerfile.replace('pnpm@11.22.0', 'pnpm@11.21.0'));

      assert.match(
        createServiceDeployInputFailures({ repoRoot }).join('\n'),
        new RegExp(`${dockerfilePath.replaceAll('.', '\\.')}: must install exactly pnpm@11\\.22\\.0`),
      );
      writeFixtureFile(repoRoot, dockerfilePath, originalDockerfile);
    }
  });
});

void test('rejects packageManager suffixes instead of silently truncating them', () => {
  withFixtureRepo((repoRoot) => {
    writeRootPackageJson(repoRoot, { packageManager: 'pnpm@11.22.0+unexpected' });
    assert.match(
      createServiceDeployInputFailures({ repoRoot }).join('\n'),
      /packageManager" must pin an exact pnpm version/,
    );
  });
});

void test('requires cumulative production detection outputs, permissions, notification range, and schema smoke', () => {
  withFixtureRepo((repoRoot) => {
    const workflowPath = join(repoRoot, '.github/workflows/production-deploy.yml');
    const weakenedWorkflow = readFileSync(workflowPath, 'utf8')
      .replace('  actions: read\n', '')
      .replace('  deployment_base_sha: example\n', '')
      .replace('BEFORE_SHA: ${{ needs.detect-changes.outputs.deployment_base_sha }}\n', '')
      .replace('run: node scripts/production-deploy-changes.mjs --runs-json "$RUNS_JSON"\n', '')
      .replace('node scripts/production-backend-smoke.mjs\n', '');
    writeFileSync(workflowPath, weakenedWorkflow, 'utf8');

    const failures = createServiceDeployInputFailures({ repoRoot }).join('\n');
    assert.match(failures, /tested cumulative change detector/);
    assert.match(failures, /read prior workflow runs/);
    assert.match(failures, /expose its cumulative baseline/);
    assert.match(failures, /report the same cumulative range/);
    assert.match(failures, /verify the live GraphQL schema/);
  });
});

void test('pins the Railway promote contract in the shared action, not the workflow', () => {
  // The three strings moved when both services started promoting through
  // .github/actions/railway-redeploy. Asserting them in the workflow would now
  // be satisfied by an action that quietly dropped the rollback.
  withFixtureRepo((repoRoot) => {
    const actionPath = '.github/actions/railway-redeploy/action.yml';
    const original = readFileSync(join(repoRoot, actionPath), 'utf8');

    for (const [needle, expectedFailure] of [
      ['capture-previous railway-before.json', /previous deployment cannot be captured/],
      ['NORMALIZED_RAILWAY_SERVICE_ID="${RAILWAY_SERVICE_ID,,}"', /normalize UUID casing/],
      ['RAILWAY_SERVICE_ID: ${{ steps.railway-validate.outputs.service_id }}', /validated normalized service identity/],
      ['^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', /canonical UUID shape/],
      ['find-new railway-deployments.json', /discover and then poll one exact new deployment/],
      ['expected-image:', /bind the service to the image/],
      ['railway-v4.66.0-x86_64-unknown-linux-gnu.tar.gz', /release asset must remain immutable/],
      ['31ca04094bee7cb4eaf7a14e0d856dae3cf4ee6c8b2b8354e652968c5d20abfe', /reviewed SHA-256 digest/],
      ['| sha256sum --check --strict', /digest must be checked/],
      ['--from-source', /re-resolve the freshly moved production tag/],
      ['timeout 30s railway deployment list', /list calls need a bounded timeout/],
      ['timeout 60s railway redeploy', /trigger needs a bounded timeout/],
      ['--json > "$RAILWAY_STATE_DIR/trigger.json"', /acknowledgement must be machine-validated/],
      ['uses: ./.github/actions/railway-rollback', /verified rollback action/],
      [
        'expected-current-deployment-id: ${{ steps.railway-wait.outputs.deployment_id }}',
        /fence the exact deployment created/,
      ],
      ['echo "deployment_id=$LOCKED_DEPLOYMENT_ID" >> "$GITHUB_OUTPUT"', /preserved before an identity failure/],
      ['if [ "$SUCCESS_CONFIRMATIONS" -ge 3 ]; then', /remain the only new deployment/],
    ]) {
      writeFixtureFile(repoRoot, actionPath, original.replace(needle, 'echo weakened'));
      assert.match(createServiceDeployInputFailures({ repoRoot }).join('\n'), expectedFailure, needle);
      writeFixtureFile(repoRoot, actionPath, original);
    }
  });
});

void test('reports a deleted Railway redeploy action instead of crashing on it', () => {
  withFixtureRepo((repoRoot) => {
    rmSync(join(repoRoot, '.github/actions/railway-redeploy/action.yml'));
    const failures = createServiceDeployInputFailures({ repoRoot }).join('\n');
    assert.match(failures, /railway-redeploy\/action\.yml: missing/);
    assert.match(failures, /shared composite action/);
  });
});

void test('requires the verified Railway rollback action, helper, and tests', () => {
  for (const [relativePath, expectedFailure] of [
    ['.github/actions/railway-rollback/action.yml', /railway-rollback\/action\.yml: missing/],
    ['scripts/railway-deployment-rollback.mjs', /railway-deployment-rollback\.mjs: missing/],
    ['scripts/railway-deployment-rollback.test.mjs', /railway-deployment-rollback\.test\.mjs: missing/],
  ]) {
    withFixtureRepo((repoRoot) => {
      rmSync(join(repoRoot, relativePath));
      assert.match(createServiceDeployInputFailures({ repoRoot }).join('\n'), expectedFailure);
    });
  }
});

void test('pins the verified Railway rollback action interface', () => {
  for (const [needle, expectedFailure] of [
    ['service-id:', /require an exact service identity/],
    ['railway-token:', /require the Railway project token/],
    ['target-deployment-id:', /require the captured rollback target/],
    ['expected-current-deployment-id:', /fence the exact deployment being replaced/],
    ['RAILWAY_SERVICE_ID: ${{ inputs.service-id }}', /service identity must reach the helper/],
    ['RAILWAY_TOKEN: ${{ inputs.railway-token }}', /Railway token must reach the helper/],
    ['TARGET_DEPLOYMENT_ID: ${{ inputs.target-deployment-id }}', /rollback target must reach the helper/],
    [
      'EXPECTED_CURRENT_DEPLOYMENT_ID: ${{ inputs.expected-current-deployment-id }}',
      /expected current deployment must reach the helper/,
    ],
    ['rollback_deployment_id:', /expose the exact verified deployment ID/],
  ]) {
    withFixtureRepo((repoRoot) => {
      const actionPath = '.github/actions/railway-rollback/action.yml';
      const original = readFileSync(join(repoRoot, actionPath), 'utf8');
      writeFixtureFile(repoRoot, actionPath, original.replace(needle, 'weakened:'));
      assert.match(createServiceDeployInputFailures({ repoRoot }).join('\n'), expectedFailure, needle);
    });
  }
});

void test('rejects raw production logs and inline rollback copies in the redeploy action', () => {
  for (const unsafeCommand of [
    'railway logs --latest',
    'curl https://backboard.railway.com',
    'deploymentRollback($ID)',
    'set +e',
    'npm install -g @railway/cli',
  ]) {
    withFixtureRepo((repoRoot) => {
      const actionPath = '.github/actions/railway-redeploy/action.yml';
      const original = readFileSync(join(repoRoot, actionPath), 'utf8');
      writeFixtureFile(repoRoot, actionPath, `${original}\n    - run: ${unsafeCommand}\n`);
      assert.match(createServiceDeployInputFailures({ repoRoot }).join('\n'), /must not dump production logs/);
    });
  }
});

void test('requires the workflow to call the shared action and rejects an inline redeploy', () => {
  withFixtureRepo((repoRoot) => {
    const workflowPath = '.github/workflows/production-deploy.yml';
    const original = readFileSync(join(repoRoot, workflowPath), 'utf8');

    writeFixtureFile(repoRoot, workflowPath, original.replace('uses: ./.github/actions/railway-redeploy', ''));
    assert.match(
      createServiceDeployInputFailures({ repoRoot }).join('\n'),
      /promote Railway services through the shared composite action/,
    );

    // A second inline copy is how the two services' promote paths drift apart.
    writeFixtureFile(repoRoot, workflowPath, `${original}          railway redeploy --service "$ID" --yes\n`);
    assert.match(createServiceDeployInputFailures({ repoRoot }).join('\n'), /not an inline copy/);

    // The phrase in a comment is not an invocation.
    writeFixtureFile(repoRoot, workflowPath, `${original}          # then \`railway redeploy\` re-pulls it\n`);
    assert.deepEqual(createServiceDeployInputFailures({ repoRoot }), []);
  });
});

void test('requires both backend and Railway-only web smoke recovery paths', () => {
  withFixtureRepo((repoRoot) => {
    const workflowPath = '.github/workflows/production-deploy.yml';
    const original = readFileSync(join(repoRoot, workflowPath), 'utf8');

    writeFixtureFile(repoRoot, workflowPath, original.replace('uses: ./.github/actions/railway-rollback', ''));
    assert.match(createServiceDeployInputFailures({ repoRoot }).join('\n'), /both use the verified rollback action/);

    writeFixtureFile(
      repoRoot,
      workflowPath,
      original.replace(
        'target-deployment-id: ${{ steps.railway-redeploy.outputs.previous_deployment_id }}',
        'target-deployment-id: wrong',
      ),
    );
    assert.match(createServiceDeployInputFailures({ repoRoot }).join('\n'), /both smoke recoveries must restore/);

    writeFixtureFile(
      repoRoot,
      workflowPath,
      original.replace(
        'expected-current-deployment-id: ${{ steps.railway-redeploy.outputs.deployment_id }}',
        'expected-current-deployment-id: wrong',
      ),
    );
    assert.match(createServiceDeployInputFailures({ repoRoot }).join('\n'), /both smoke recoveries must fence/);
  });
});

void test('requires the production web build to use the generated Docker context', () => {
  withFixtureRepo((repoRoot) => {
    const workflowPath = '.github/workflows/production-deploy.yml';
    const original = readFileSync(join(repoRoot, workflowPath), 'utf8');

    writeFixtureFile(
      repoRoot,
      workflowPath,
      original.replace('run: node scripts/create-service-docker-context.mjs web\n', ''),
    );
    assert.match(createServiceDeployInputFailures({ repoRoot }).join('\n'), /generate the web Docker context/);

    writeFixtureFile(repoRoot, workflowPath, original.replace('context: .docker-context/web\n', ''));
    assert.match(
      createServiceDeployInputFailures({ repoRoot }).join('\n'),
      /Production web build must use the generated Docker context/,
    );
  });
});

void test('requires a railway.web.toml that never puts Railway back in charge of building', () => {
  withFixtureRepo((repoRoot) => {
    writeFixtureFile(repoRoot, 'railway.web.toml', '[build]\nbuilder = "NIXPACKS"\n\n[deploy]\n');
    assert.match(createServiceDeployInputFailures({ repoRoot }).join('\n'), /GHCR web image built by GitHub Actions/);

    rmSync(join(repoRoot, 'railway.web.toml'));
    const failures = createServiceDeployInputFailures({ repoRoot }).join('\n');
    assert.match(failures, /railway\.web\.toml: missing/);
    assert.match(failures, /its own config file/);
  });
});

void test('rejects hand-maintained workspace manifest COPY lines in Dockerfiles', () => {
  withFixtureRepo((repoRoot) => {
    writeFixtureFile(
      repoRoot,
      'Dockerfile.backend',
      dockerfileLines(['COPY packages/backend/package.json ./packages/backend/']),
    );

    const failures = createServiceDeployInputFailures({ repoRoot });
    assert.match(failures.join('\n'), /Workspace manifest copies must be generated/);
  });
});

void test('requires pnpm-workspace.yaml in the install layer', () => {
  withFixtureRepo((repoRoot) => {
    const dockerfilePath = join(repoRoot, 'Dockerfile.backend');
    writeFileSync(
      dockerfilePath,
      readFileSync(dockerfilePath, 'utf8').replace(
        'COPY manifests/package.json manifests/pnpm-lock.yaml manifests/pnpm-workspace.yaml ./',
        'COPY manifests/package.json manifests/pnpm-lock.yaml ./',
      ),
      'utf8',
    );

    assert.match(
      createServiceDeployInputFailures({ repoRoot }).join('\n'),
      /missing COPY manifests\/package\.json manifests\/pnpm-lock\.yaml manifests\/pnpm-workspace\.yaml/,
    );
  });
});

void test('rejects patchedDependencies without a patches COPY in the install layer', () => {
  withFixtureRepo((repoRoot) => {
    writeWorkspaceYaml(repoRoot, { patchedDependencies: { 'left-pad@1.0.0': 'patches/left-pad@1.0.0.patch' } });
    writeFixtureFile(repoRoot, 'patches/left-pad@1.0.0.patch', 'diff\n');

    const failures = createServiceDeployInputFailures({ repoRoot });
    assert.match(failures.join('\n'), /missing COPY manifests\/patches \.\/patches/);
  });
});

void test('passes when patchedDependencies are wired into the install layer', () => {
  withFixtureRepo((repoRoot) => {
    writeWorkspaceYaml(repoRoot, { patchedDependencies: { 'left-pad@1.0.0': 'patches/left-pad@1.0.0.patch' } });
    writeFixtureFile(repoRoot, 'patches/left-pad@1.0.0.patch', 'diff\n');

    const dockerfile = dockerfileLines(['COPY manifests/patches ./patches']);
    writeFixtureFile(repoRoot, 'Dockerfile.backend', dockerfile);
    writeFixtureFile(repoRoot, 'Dockerfile.web', dockerfile);
    writeFixtureFile(repoRoot, 'Dockerfile.sync', dockerfile);

    assert.deepEqual(createServiceDeployInputFailures({ repoRoot }), []);
  });
});

void test('rejects source package COPY instructions before pnpm install', () => {
  withFixtureRepo((repoRoot) => {
    writeFixtureFile(
      repoRoot,
      'Dockerfile.web',
      ['FROM node:22-alpine', 'COPY packages/ ./packages/', dockerfileLines()].join('\n'),
    );

    const failures = createServiceDeployInputFailures({ repoRoot });
    assert.match(failures.join('\n'), /appears before pnpm install/);
  });
});

void test('does not mistake a comment naming the install command for the install itself', () => {
  withFixtureRepo((repoRoot) => {
    writeWorkspaceYaml(repoRoot, { patchedDependencies: { 'left-pad@1.0.0': 'patches/left-pad@1.0.0.patch' } });
    writeFixtureFile(repoRoot, 'patches/left-pad@1.0.0.patch', 'diff\n');
    const dockerfile = dockerfileLines([
      '# Patch files must be present before install, or `pnpm install --frozen-lockfile` fails.',
      'COPY manifests/patches ./patches',
    ]);
    writeFixtureFile(repoRoot, 'Dockerfile.backend', dockerfile);
    writeFixtureFile(repoRoot, 'Dockerfile.web', dockerfile);
    writeFixtureFile(repoRoot, 'Dockerfile.sync', dockerfile);
    assert.deepEqual(createServiceDeployInputFailures({ repoRoot }), []);
  });
});

void test('rejects a patches COPY after the install', () => {
  withFixtureRepo((repoRoot) => {
    writeWorkspaceYaml(repoRoot, { patchedDependencies: { 'left-pad@1.0.0': 'patches/left-pad@1.0.0.patch' } });
    writeFixtureFile(repoRoot, 'patches/left-pad@1.0.0.patch', 'diff\n');
    const dockerfile = `${dockerfileLines()}COPY manifests/patches ./patches\n`;
    writeFixtureFile(repoRoot, 'Dockerfile.backend', dockerfile);
    writeFixtureFile(repoRoot, 'Dockerfile.web', dockerfile);
    assert.match(
      createServiceDeployInputFailures({ repoRoot }).join('\n'),
      /COPY manifests\/patches \.\/patches must appear before pnpm install/,
    );
  });
});

void test('rejects leftover Bun invocations in a Dockerfile', () => {
  withFixtureRepo((repoRoot) => {
    writeFixtureFile(repoRoot, 'Dockerfile.backend', `${dockerfileLines()}CMD ["bunx", "tsx", "src/index.ts"]\n`);
    assert.match(createServiceDeployInputFailures({ repoRoot }).join('\n'), /Bun is not installed/);
  });
});

void test('rejects pnpm settings left in root package.json', () => {
  withFixtureRepo((repoRoot) => {
    writeRootPackageJson(repoRoot, {
      workspaces: ['packages/*'],
      overrides: { 'react-native-screens': '4.26.2' },
      patchedDependencies: { 'left-pad@1.0.0': 'patches/left-pad@1.0.0.patch' },
    });
    const failures = createServiceDeployInputFailures({ repoRoot }).join('\n');
    assert.match(failures, /"workspaces" moved to pnpm-workspace\.yaml/);
    assert.match(failures, /"overrides" moved to pnpm-workspace\.yaml/);
    assert.match(failures, /"patchedDependencies" moved to pnpm-workspace\.yaml/);
  });
});

void test('rejects an empty workspace package list', () => {
  withFixtureRepo((repoRoot) => {
    writeWorkspaceYaml(repoRoot, { packages: [] });
    assert.match(createServiceDeployInputFailures({ repoRoot }).join('\n'), /no "packages:" entries/);
  });
});

void test('rejects a Vercel pnpm pin that drifts from packageManager', () => {
  withFixtureRepo((repoRoot) => {
    writeVercelJson(repoRoot, '10.4.1');
    const failures = createServiceDeployInputFailures({ repoRoot }).join('\n');
    assert.match(failures, /"installCommand" must pin pnpm@11\.22\.0/);
    assert.match(failures, /"buildCommand" must pin pnpm@11\.22\.0/);
  });
});

void test('rejects a resurrected bun.lock', () => {
  withFixtureRepo((repoRoot) => {
    writeFixtureFile(repoRoot, 'bun.lock', '');
    assert.match(createServiceDeployInputFailures({ repoRoot }).join('\n'), /bun\.lock: remove this file/);
  });
});

void test('passes when Dockerfile.sync and the sync packages are present', () => {
  withFixtureRepo((repoRoot) => {
    // Dockerfile.sync is optional, so the base fixture skips it. Add the
    // workspaces the `sync` service roots from plus a valid Dockerfile.sync so
    // the optional sync validation (requireDockerContextFile + the generated
    // `sync` context) actually runs and is asserted green.
    writePackage(repoRoot, 'packages/kilter-sync', {
      name: '@boardsesh/kilter-sync',
      dependencies: { '@boardsesh/shared-lib': 'workspace:*' },
    });
    writePackage(repoRoot, 'packages/aurora-sync', { name: '@boardsesh/aurora-sync' });
    writePackage(repoRoot, 'packages/moonboard-sync', { name: '@boardsesh/moonboard-sync' });
    writePackage(repoRoot, 'packages/scheduler', { name: '@boardsesh/scheduler' });

    writeFixtureFile(repoRoot, 'Dockerfile.sync', dockerfileLines());

    assert.deepEqual(createServiceDeployInputFailures({ repoRoot }), []);
  });
});
