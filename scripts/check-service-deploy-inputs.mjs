import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createServiceDockerContext,
  getPatchedDependencies,
  getServiceSourcePackageDirs,
  getWorkspacePackageJsonPaths,
  getWorkspacePatterns,
  requiredRootManifestFiles,
} from './create-service-docker-context.mjs';

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toPosix = (filePath) => filePath.split(sep).join(posix.sep);

const readRepoFile = (repoRoot, relativePath) => readFileSync(join(repoRoot, relativePath), 'utf8');

function listFiles(rootDirectory) {
  if (!existsSync(rootDirectory)) return [];

  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(toPosix(relative(rootDirectory, absolutePath)));
      }
    }
  };
  visit(rootDirectory);
  return files.sort((left, right) => left.localeCompare(right));
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function comparePathLists(failures, label, actual, expected) {
  if (arraysEqual(actual, expected)) return;

  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((item) => !actualSet.has(item));
  const extra = actual.filter((item) => !expectedSet.has(item));

  if (missing.length > 0) failures.push(`${label}: missing ${missing.join(', ')}`);
  if (extra.length > 0) failures.push(`${label}: unexpected ${extra.join(', ')}`);
}

function requireFileIncludes(failures, repoRoot, relativePath, expectedText, reason) {
  const fileContents = readRepoFile(repoRoot, relativePath);
  if (!fileContents.includes(expectedText)) {
    failures.push(`${relativePath}: missing ${JSON.stringify(expectedText)} (${reason})`);
  }
}

function rejectFilePattern(failures, repoRoot, relativePath, pattern, reason) {
  const fileContents = readRepoFile(repoRoot, relativePath);
  const match = fileContents.match(pattern);
  if (match) {
    failures.push(`${relativePath}: found ${JSON.stringify(match[0])} (${reason})`);
  }
}

/** Guards `requireFileIncludes`, which throws rather than reports on a missing file. */
function requireExistingFile(failures, repoRoot, relativePath, reason) {
  if (existsSync(join(repoRoot, relativePath))) return true;
  failures.push(`${relativePath}: missing (${reason})`);
  return false;
}

function rejectExistingFile(failures, repoRoot, relativePath, reason) {
  if (existsSync(join(repoRoot, relativePath))) {
    failures.push(`${relativePath}: remove this file (${reason})`);
  }
}

function indexOfInstruction(fileContents, needle) {
  let lineStart = 0;
  for (const line of fileContents.split('\n')) {
    const columnIndex = line.trimStart().startsWith('#') ? -1 : line.indexOf(needle);
    if (columnIndex !== -1) return lineStart + columnIndex;
    lineStart += line.length + 1;
  }
  return -1;
}

function requireDockerContextFile(failures, repoRoot, dockerfilePath) {
  const dockerfileContents = readRepoFile(repoRoot, dockerfilePath);
  const installIndex = indexOfInstruction(dockerfileContents, 'pnpm install --frozen-lockfile');
  if (installIndex === -1) {
    failures.push(`${dockerfilePath}: missing frozen pnpm install layer`);
    return;
  }

  const manifestRootCopy = `COPY ${requiredRootManifestFiles.map((file) => `manifests/${file}`).join(' ')} ./`;
  const manifestPackagesCopy = 'COPY manifests/packages ./packages';
  const sourcePackagesCopy = 'COPY source/packages ./packages';

  const requiredPreInstallCopies = [manifestRootCopy, manifestPackagesCopy];

  // patchedDependencies are resolved during install, so the patch files must be
  // copied into the install layer or `pnpm install --frozen-lockfile` fails.
  if (Object.keys(getPatchedDependencies(repoRoot)).length > 0) {
    requiredPreInstallCopies.push('COPY manifests/patches ./patches');
  }

  for (const copyLine of requiredPreInstallCopies) {
    const copyIndex = indexOfInstruction(dockerfileContents, copyLine);
    if (copyIndex === -1) {
      failures.push(`${dockerfilePath}: missing ${copyLine}`);
    } else if (copyIndex > installIndex) {
      failures.push(`${dockerfilePath}: ${copyLine} must appear before pnpm install`);
    }
  }

  if (indexOfInstruction(dockerfileContents, sourcePackagesCopy) === -1) {
    failures.push(`${dockerfilePath}: missing ${sourcePackagesCopy}`);
  }

  const preInstallContents = dockerfileContents.slice(0, installIndex);
  const preInstallSourceCopy = preInstallContents.match(/^COPY (?:packages|source)\//m);
  if (preInstallSourceCopy) {
    failures.push(
      `${dockerfilePath}: ${JSON.stringify(preInstallSourceCopy[0])} appears before pnpm install; only generated manifests may feed the install cache layer`,
    );
  }

  rejectFilePattern(
    failures,
    repoRoot,
    dockerfilePath,
    /\bbunx\b|\bbun (?:install|run|x|--)\b|bun\.sh\/install/,
    'Images run on pnpm and node; Bun is not installed in them.',
  );

  rejectFilePattern(
    failures,
    repoRoot,
    dockerfilePath,
    /^COPY packages\/.+package\.json .+/m,
    'Workspace manifest copies must be generated by scripts/create-service-docker-context.mjs, not hand-maintained in Dockerfiles.',
  );
  rejectFilePattern(
    failures,
    repoRoot,
    dockerfilePath,
    /^COPY packages\/ \.\/packages\//m,
    'Do not copy full workspace source before install; it busts Docker install cache.',
  );
}

function verifyGeneratedContext(failures, repoRoot, serviceName, outputRoot) {
  const outputDir = join(outputRoot, serviceName);
  const result = createServiceDockerContext({ serviceName, repoRoot, outputDir });
  const expectedManifestPaths = getWorkspacePackageJsonPaths(repoRoot);
  const actualManifestPaths = listFiles(join(result.outputDir, 'manifests', 'packages')).map((filePath) =>
    posix.join('packages', filePath),
  );
  comparePathLists(failures, `${serviceName} Docker context manifests`, actualManifestPaths, expectedManifestPaths);

  const expectedSourceDirs = getServiceSourcePackageDirs(serviceName, repoRoot);
  const workspacePackageDirs = getWorkspacePackageJsonPaths(repoRoot).map((packageJsonPath) =>
    posix.dirname(packageJsonPath),
  );
  const actualSourceDirs = workspacePackageDirs.filter((packageDirectory) =>
    existsSync(join(result.outputDir, 'source', packageDirectory, 'package.json')),
  );
  comparePathLists(failures, `${serviceName} Docker context source packages`, actualSourceDirs, expectedSourceDirs);

  for (const patchRelativePath of Object.values(getPatchedDependencies(repoRoot)).map(String)) {
    if (!existsSync(join(result.outputDir, 'manifests', patchRelativePath))) {
      failures.push(`${serviceName} Docker context: missing manifests/${patchRelativePath}`);
    }
  }

  for (const rootManifestFile of requiredRootManifestFiles) {
    if (!existsSync(join(result.outputDir, 'manifests', rootManifestFile))) {
      failures.push(`${serviceName} Docker context: missing manifests/${rootManifestFile}`);
    }
  }

  if (!existsSync(join(result.outputDir, 'Dockerfile'))) {
    failures.push(`${serviceName} Docker context: missing Dockerfile`);
  }
}

function requirePnpmWorkspaceInputs(failures, repoRoot) {
  const rootPackageJson = JSON.parse(readRepoFile(repoRoot, 'package.json'));
  for (const staleKey of ['pnpm', 'overrides', 'patchedDependencies', 'workspaces', 'resolutions']) {
    if (rootPackageJson[staleKey] !== undefined) {
      failures.push(
        `package.json: "${staleKey}" moved to pnpm-workspace.yaml under pnpm 11; leaving it here is silently inert`,
      );
    }
  }

  let workspaceConfigUsable = true;
  try {
    getWorkspacePatterns(repoRoot);
  } catch (error) {
    failures.push(`pnpm-workspace.yaml: ${error.message}`);
    workspaceConfigUsable = false;
  }

  const packageManager = String(rootPackageJson.packageManager ?? '');
  const packageManagerMatch = packageManager.match(/^pnpm@(\d+\.\d+\.\d+)$/);
  if (!packageManagerMatch) {
    failures.push(
      `package.json: "packageManager" must pin an exact pnpm version; got ${JSON.stringify(packageManager)}`,
    );
  } else {
    const pinnedVersion = packageManagerMatch[1];
    for (const dockerfilePath of [
      'Dockerfile.backend',
      'Dockerfile.web',
      'Dockerfile.sync',
      'packages/db/docker/Dockerfile.dev-db',
    ]) {
      if (!existsSync(join(repoRoot, dockerfilePath))) continue;
      const dockerfile = readRepoFile(repoRoot, dockerfilePath);
      const installedVersions = [...dockerfile.matchAll(/npm install --global[^\n]*\bpnpm@(\d+\.\d+\.\d+)\b/g)].map(
        (match) => match[1],
      );
      if (installedVersions.length !== 1 || installedVersions[0] !== pinnedVersion) {
        failures.push(
          `${dockerfilePath}: must install exactly pnpm@${pinnedVersion} to match package.json packageManager; ` +
            `found ${JSON.stringify(installedVersions)}`,
        );
      }
    }

    const vercelConfigPath = 'packages/web/vercel.json';
    if (!existsSync(join(repoRoot, vercelConfigPath))) {
      failures.push(
        `${vercelConfigPath}: missing; Vercel needs an explicit pnpm@${pinnedVersion} install/build command`,
      );
    } else {
      const vercelConfig = JSON.parse(readRepoFile(repoRoot, vercelConfigPath));
      for (const commandKey of ['installCommand', 'buildCommand']) {
        const command = String(vercelConfig[commandKey] ?? '');
        if (!command.includes(`pnpm@${pinnedVersion}`)) {
          failures.push(
            `${vercelConfigPath}: "${commandKey}" must pin pnpm@${pinnedVersion} to match package.json packageManager; got ${JSON.stringify(command)}`,
          );
        }
      }
    }
  }

  return workspaceConfigUsable;
}

function createServiceDeployInputFailures({ repoRoot = defaultRepoRoot } = {}) {
  const failures = [];

  const workspaceConfigUsable = requirePnpmWorkspaceInputs(failures, repoRoot);

  if (workspaceConfigUsable) {
    for (const dockerfilePath of ['Dockerfile.backend', 'Dockerfile.web', 'Dockerfile.sync']) {
      if (dockerfilePath === 'Dockerfile.sync' && !existsSync(join(repoRoot, dockerfilePath))) continue;
      requireDockerContextFile(failures, repoRoot, dockerfilePath);
    }

    const outputRoot = mkdtempSync(join(tmpdir(), 'boardsesh-service-docker-context-'));
    try {
      verifyGeneratedContext(failures, repoRoot, 'backend', outputRoot);
      verifyGeneratedContext(failures, repoRoot, 'web', outputRoot);
      if (existsSync(join(repoRoot, 'Dockerfile.sync'))) {
        verifyGeneratedContext(failures, repoRoot, 'sync', outputRoot);
      }
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  }

  const branchBackendChangePattern =
    'packages/*|Dockerfile.backend|scripts/create-service-docker-context.mjs|pnpm-lock.yaml|pnpm-workspace.yaml|package.json';

  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/branch-deploy.yml',
    branchBackendChangePattern,
    'Branch deploy backend detection must treat any workspace package or Docker install input as backend-affecting.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    'node scripts/production-deploy-changes.mjs --runs-json',
    'Production deploy must use the tested cumulative change detector.',
  );

  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/branch-deploy.yml',
    'vp run docker-context:web',
    'Branch deploy must generate the web Docker context before building.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/branch-deploy.yml',
    'context: .docker-context/web',
    'Branch deploy web build must use the generated Docker context.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/branch-deploy.yml',
    'vp run docker-context:backend',
    'Branch deploy must generate the backend Docker context before building.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/branch-deploy.yml',
    'context: .docker-context/backend',
    'Branch deploy backend build must use the generated Docker context.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    'vp run docker-context:backend',
    'Production deploy must generate the backend Docker context before building.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    'context: .docker-context/backend',
    'Production backend build must use the generated Docker context.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    'vp run docker-context:web',
    'Production deploy must generate the web Docker context before building.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    'context: .docker-context/web',
    'Production web build must use the generated Docker context.',
  );

  for (const workflowPath of ['.github/workflows/branch-deploy.yml', '.github/workflows/production-deploy.yml']) {
    rejectFilePattern(
      failures,
      repoRoot,
      workflowPath,
      /packages\/backend\/\*/,
      'Backend detection must not hardcode individual workspace packages.',
    );
  }

  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/e2e-tests.yml',
    'find packages -type d -name dist -prune',
    'E2E build artifacts must include package dist outputs dynamically.',
  );
  rejectFilePattern(
    failures,
    repoRoot,
    '.github/workflows/e2e-tests.yml',
    /packages\/\S+\/dist\//,
    'E2E build artifacts must not enumerate package dist outputs.',
  );

  requireFileIncludes(
    failures,
    repoRoot,
    '.dockerignore',
    '**/node_modules',
    'Docker builds must not copy local installs.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.dockerignore',
    '**/dist',
    'Docker builds must not copy stale build output.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.dockerignore',
    '.docker-context',
    'Generated Docker contexts must not be nested into root Docker builds.',
  );

  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    'group: production-deploy',
    'Production deploy must have a dedicated concurrency group.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    'cancel-in-progress: false',
    'Production deploy must not be cancelled by newer pushes.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    'actions: read',
    'Production change detection must be able to read prior workflow runs.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    'deployment_base_sha:',
    'Production deploy must expose its cumulative baseline to downstream notifications.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    'static_assets_changed:',
    'Production deploy must expose the cumulative static-assets change signal.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    'run: vp run upload:static-assets',
    'Production deploy must publish static assets through the sanctioned vp task.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    "needs.sync-static-assets.result == 'success' || needs.sync-static-assets.result == 'skipped'",
    'Production artifacts must wait for static asset publication when it runs.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    'SYNC_STATIC_ASSETS: ${{ needs.sync-static-assets.result }}',
    'Production failure notifications must report static asset publication failures.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    'BEFORE_SHA: ${{ needs.detect-changes.outputs.deployment_base_sha }}',
    'Production notifications must report the same cumulative range that was deployed.',
  );
  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    'node scripts/production-backend-smoke.mjs',
    'Production backend deploy must verify the live GraphQL schema.',
  );
  // The capture / poll / rollback contract moved out of the workflow and into
  // the composite action when the web service joined the backend on Railway, so
  // the pins move with it. Asserting them in the workflow would now pass on an
  // action that had quietly dropped the rollback, which is the opposite of what
  // these checks are for.
  const railwayRedeployAction = '.github/actions/railway-redeploy/action.yml';
  if (
    requireExistingFile(
      failures,
      repoRoot,
      railwayRedeployAction,
      'Both Railway services promote through this shared composite action.',
    )
  ) {
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      'scripts/railway-deployment-status.mjs capture-previous',
      'The Railway redeploy must fail if the previous deployment cannot be captured.',
    );
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      'NORMALIZED_RAILWAY_SERVICE_ID="${RAILWAY_SERVICE_ID,,}"',
      'The Railway CLI service identity must normalize UUID casing before use.',
    );
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      'RAILWAY_SERVICE_ID: ${{ steps.railway-validate.outputs.service_id }}',
      'The Railway CLI must receive the validated normalized service identity.',
    );
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
      'The Railway CLI service identity must require the canonical UUID shape.',
    );
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      'scripts/railway-deployment-status.mjs find-new',
      'The Railway redeploy must discover and then poll one exact new deployment.',
    );
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      'expected-image:',
      'The Railway redeploy must bind the service to the image built by this workflow.',
    );
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      'railway-v4.66.0-x86_64-unknown-linux-gnu.tar.gz',
      'The reviewed Railway CLI release asset must remain immutable.',
    );
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      '31ca04094bee7cb4eaf7a14e0d856dae3cf4ee6c8b2b8354e652968c5d20abfe',
      'The Railway CLI release asset must be verified by its reviewed SHA-256 digest.',
    );
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      '| sha256sum --check --strict',
      'The Railway CLI digest must be checked before extraction or execution.',
    );
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      '--from-source',
      'Image-backed Railway services must re-resolve the freshly moved production tag.',
    );
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      'timeout 30s railway deployment list',
      'Railway list calls need a bounded timeout so retry and recovery remain reachable.',
    );
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      'timeout 60s railway redeploy',
      'The Railway trigger needs a bounded timeout before exact-ID discovery and recovery.',
    );
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      '--json > "$RAILWAY_STATE_DIR/trigger.json"',
      'The Railway trigger acknowledgement must be machine-validated before discovery.',
    );
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      'uses: ./.github/actions/railway-rollback',
      'The Railway redeploy must restore the captured deployment through the verified rollback action.',
    );
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      'expected-current-deployment-id: ${{ steps.railway-wait.outputs.deployment_id }}',
      'Redeploy recovery must fence the exact deployment created by the action.',
    );
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      'echo "deployment_id=$LOCKED_DEPLOYMENT_ID" >> "$GITHUB_OUTPUT"',
      'The exact candidate ID must be preserved before an identity failure invokes recovery.',
    );
    requireFileIncludes(
      failures,
      repoRoot,
      railwayRedeployAction,
      'if [ "$SUCCESS_CONFIRMATIONS" -ge 3 ]; then',
      'A successful candidate must remain the only new deployment across multiple reads.',
    );
    rejectFilePattern(
      failures,
      repoRoot,
      railwayRedeployAction,
      /\brailway logs\b|curl[^\n]*backboard\.railway\.com|deploymentRollback\s*\(|\bset \+e\b|npm\s+install[^\n]*@railway\/cli/,
      'Redeploy recovery must not dump production logs, call Railway GraphQL inline, ignore failures, or run the CLI npm postinstall.',
    );
  }

  const railwayRollbackAction = '.github/actions/railway-rollback/action.yml';
  if (
    requireExistingFile(
      failures,
      repoRoot,
      railwayRollbackAction,
      'Failed deploy and smoke paths share one exact-ID rollback implementation.',
    )
  ) {
    for (const [needle, reason] of [
      ['service-id:', 'The rollback action must require an exact service identity.'],
      ['railway-token:', 'The rollback action must require the Railway project token.'],
      ['target-deployment-id:', 'The rollback action must require the captured rollback target.'],
      ['expected-current-deployment-id:', 'The rollback action must fence the exact deployment being replaced.'],
      ['RAILWAY_SERVICE_ID: ${{ inputs.service-id }}', 'The service identity must reach the helper through env.'],
      ['RAILWAY_TOKEN: ${{ inputs.railway-token }}', 'The Railway token must reach the helper through env.'],
      [
        'TARGET_DEPLOYMENT_ID: ${{ inputs.target-deployment-id }}',
        'The rollback target must reach the helper through env.',
      ],
      [
        'EXPECTED_CURRENT_DEPLOYMENT_ID: ${{ inputs.expected-current-deployment-id }}',
        'The expected current deployment must reach the helper through env.',
      ],
      ['node scripts/railway-deployment-rollback.mjs', 'The rollback action must use the tested GraphQL helper.'],
      ['rollback_deployment_id:', 'The rollback action must expose the exact verified deployment ID.'],
    ]) {
      requireFileIncludes(failures, repoRoot, railwayRollbackAction, needle, reason);
    }
  }
  for (const rollbackPath of [
    'scripts/railway-deployment-rollback.mjs',
    'scripts/railway-deployment-rollback.test.mjs',
  ]) {
    requireExistingFile(
      failures,
      repoRoot,
      rollbackPath,
      'Verified Railway rollback code and tests are required deployment controls.',
    );
  }
  const railwayRollbackHelper = 'scripts/railway-deployment-rollback.mjs';
  if (existsSync(join(repoRoot, railwayRollbackHelper))) {
    for (const [needle, reason] of [
      ['Project-Access-Token', 'Railway project tokens must use the project-token header.'],
      ['deployment(id: $id)', 'Rollback verification must poll the exact returned deployment ID.'],
      ['deploymentRollback(id: $id)', 'Rollback must call the official exact-target mutation.'],
      ['canRollback', 'Rollback must require Railway to report the captured target as rollback-capable.'],
      ['AbortSignal.timeout', 'Every Railway GraphQL request needs a bounded timeout.'],
    ]) {
      requireFileIncludes(failures, repoRoot, railwayRollbackHelper, needle, reason);
    }
    rejectFilePattern(
      failures,
      repoRoot,
      railwayRollbackHelper,
      /Authorization:\s*Bearer|\bcurl\b/,
      'The verified rollback helper must not use user-token auth or an unbounded curl copy.',
    );
  }

  requireFileIncludes(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    'uses: ./.github/actions/railway-redeploy',
    'Production deploy must promote Railway services through the shared composite action.',
  );
  const productionDeploySource = readRepoFile(repoRoot, '.github/workflows/production-deploy.yml');
  if ((productionDeploySource.match(/uses: \.\/\.github\/actions\/railway-rollback/g) ?? []).length < 2) {
    failures.push(
      '.github/workflows/production-deploy.yml: backend and Railway-only web smoke failures must both use the verified rollback action',
    );
  }
  if (
    (
      productionDeploySource.match(
        /target-deployment-id: \$\{\{ steps\.railway-redeploy\.outputs\.previous_deployment_id \}\}/g,
      ) ?? []
    ).length < 2
  ) {
    failures.push(
      '.github/workflows/production-deploy.yml: both smoke recoveries must restore the captured previous deployment ID',
    );
  }
  if (
    (
      productionDeploySource.match(
        /expected-current-deployment-id: \$\{\{ steps\.railway-redeploy\.outputs\.deployment_id \}\}/g,
      ) ?? []
    ).length < 2
  ) {
    failures.push(
      '.github/workflows/production-deploy.yml: both smoke recoveries must fence the exact current deployment ID',
    );
  }
  // A second inline copy is how the backend and web promote paths drift: one
  // gets a fix, the other keeps the bug. Matches a command line, not the phrase
  // in a comment.
  rejectFilePattern(
    failures,
    repoRoot,
    '.github/workflows/production-deploy.yml',
    /^\s*railway\s+redeploy\b/m,
    'Railway redeploys must go through .github/actions/railway-redeploy, not an inline copy.',
  );

  rejectFilePattern(
    failures,
    repoRoot,
    'railway.toml',
    /^\[build\]/m,
    'Railway must deploy the GHCR image built by GitHub Actions.',
  );
  if (
    requireExistingFile(
      failures,
      repoRoot,
      'railway.web.toml',
      "The Railway web service needs its own config file; the root railway.toml is the backend's.",
    )
  ) {
    rejectFilePattern(
      failures,
      repoRoot,
      'railway.web.toml',
      /^\[build\]/m,
      'Railway must deploy the GHCR web image built by GitHub Actions.',
    );
  }
  rejectExistingFile(
    failures,
    repoRoot,
    '.github/workflows/backend-deploy.yml',
    'production-deploy.yml is the only production deployment workflow.',
  );
  rejectExistingFile(
    failures,
    repoRoot,
    'packages/backend/railway.toml',
    'The root railway.toml is the only Railway deployment config.',
  );
  rejectExistingFile(
    failures,
    repoRoot,
    'packages/backend/Dockerfile',
    'The root Dockerfile.backend is the only backend deployment image.',
  );
  rejectExistingFile(
    failures,
    repoRoot,
    'Dockerfile.backend.dockerignore',
    'Generated Docker contexts replace Dockerfile-specific ignore files.',
  );
  rejectExistingFile(
    failures,
    repoRoot,
    'Dockerfile.web.dockerignore',
    'Generated Docker contexts replace Dockerfile-specific ignore files.',
  );
  rejectExistingFile(
    failures,
    repoRoot,
    'Dockerfile.sync.dockerignore',
    'Generated Docker contexts replace Dockerfile-specific ignore files.',
  );
  rejectExistingFile(
    failures,
    repoRoot,
    'bun.lock',
    'The workspace installs with pnpm; a Bun lockfile would go stale and mislead cache keys.',
  );

  return failures;
}

function runCli() {
  const failures = createServiceDeployInputFailures();
  if (failures.length > 0) {
    console.error('Service deployment input checks failed:');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log('Service deployment input checks passed.');
}

const invokedAsScript = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedAsScript) {
  runCli();
}

export { createServiceDeployInputFailures };
