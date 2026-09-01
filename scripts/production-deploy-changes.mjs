#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const ZERO_SHA = '0000000000000000000000000000000000000000';
const ALL_TARGETS = Object.freeze({ web: true, backend: true, app: true, cloudflare: true, staticAssets: true });
const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function fullDeploy(reason) {
  return {
    ...ALL_TARGETS,
    deploymentBaseSha: '',
    changedFiles: [],
    fullBuild: true,
    reason,
  };
}

function asWorkflowRuns(payload) {
  if (!payload || !Array.isArray(payload.workflow_runs)) return null;
  return payload.workflow_runs;
}

function selectLatestSuccessfulPriorRun(payload, { currentRunId = '' } = {}) {
  const workflowRuns = asWorkflowRuns(payload);
  if (!workflowRuns) return null;

  return (
    workflowRuns.find((run) => {
      const headSha = typeof run?.head_sha === 'string' ? run.head_sha.trim() : '';
      return (
        run?.status === 'completed' &&
        run?.conclusion === 'success' &&
        FULL_COMMIT_SHA_PATTERN.test(headSha) &&
        headSha !== ZERO_SHA &&
        (currentRunId === '' || String(run?.id ?? '') !== String(currentRunId))
      );
    }) ?? null
  );
}

function isProductionDeployControlFile(filePath) {
  return filePath === '.github/workflows/production-deploy.yml' || filePath === 'scripts/production-deploy-changes.mjs';
}

// CI-only files that never reach production: the deploy watchdog is a
// scheduled janitor for the concurrency group, not shipped code, so editing it
// must not queue a web deploy of its own.
function isProductionDeployWatchdogFile(filePath) {
  return (
    filePath === '.github/workflows/production-deploy-watchdog.yml' ||
    filePath === 'scripts/production-deploy-watchdog.mjs' ||
    filePath === 'scripts/production-deploy-watchdog.test.mjs'
  );
}

function isProductionDeployTestFile(filePath) {
  return (
    filePath === 'scripts/__tests__/docker-build-release-stamp.test.ts' ||
    filePath === 'scripts/production-backend-smoke.test.mjs' ||
    filePath === 'scripts/production-deploy-changes.test.mjs' ||
    filePath === 'scripts/production-web-deploy-targets.test.mjs' ||
    filePath === 'scripts/railway-deployment-rollback.test.mjs' ||
    filePath === 'scripts/railway-deployment-status.test.mjs' ||
    filePath === 'scripts/production-smoke.test.ts'
  );
}

// Cloudflare zone config-as-code: the desired state and the script that
// converges it. Deliberately NOT web-affecting (see isWebAffecting) — a cache
// rule or WAF edit changes the edge, not the Next build, so it must not queue a
// web deploy of its own.
function isCloudflareAffecting(filePath) {
  return (
    filePath.startsWith('infra/cloudflare/') ||
    filePath === 'scripts/cloudflare-apply.ts' ||
    filePath === 'scripts/cloudflare-apply.test.ts'
  );
}

function isStaticAssetsAffecting(filePath) {
  return (
    (filePath.startsWith('packages/web/public/images/') && filePath.endsWith('.webp')) ||
    filePath === 'packages/web/public/brand/boardsesh-mark.png' ||
    (filePath.startsWith('packages/web/public/icons/') && filePath.endsWith('.png')) ||
    filePath === 'packages/web/app/favicon.ico' ||
    filePath === 'packages/web/app/icon.png' ||
    filePath.startsWith('packages/shared/static-assets/') ||
    filePath === 'scripts/generate-static-assets.ts' ||
    filePath === 'scripts/lib/static-asset-catalog.ts' ||
    filePath === 'scripts/upload-static-assets.ts' ||
    filePath === 'scripts/lib/static-asset-upload.ts'
  );
}

function isBackendAffecting(filePath) {
  return (
    filePath.startsWith('packages/') ||
    filePath === 'Dockerfile.backend' ||
    filePath === 'scripts/create-service-docker-context.mjs' ||
    filePath === 'scripts/production-backend-smoke.mjs' ||
    filePath === 'scripts/railway-deployment-rollback.mjs' ||
    filePath === 'scripts/railway-deployment-status.mjs' ||
    // The composite action that redeploys BOTH Railway services. It carries the
    // capture/redeploy/poll/rollback logic that used to be inline in the
    // workflow, so a change to it changes how the backend ships.
    filePath.startsWith('.github/actions/railway-redeploy/') ||
    filePath.startsWith('.github/actions/railway-rollback/') ||
    filePath === 'railway.toml' ||
    filePath === 'pnpm-lock.yaml' ||
    filePath === 'pnpm-workspace.yaml' ||
    filePath === 'package.json' ||
    filePath === '.github/workflows/production-deploy.yml'
  );
}

function isWebAffecting(filePath) {
  return !(
    filePath.startsWith('mobile/') ||
    filePath.startsWith('packages/mobile/') ||
    filePath.startsWith('docs/') ||
    filePath.endsWith('.md') ||
    filePath === 'scripts/production-backend-smoke.mjs' ||
    isProductionDeployTestFile(filePath) ||
    isProductionDeployWatchdogFile(filePath) ||
    isCloudflareAffecting(filePath)
  );
}

function isAppAffecting(filePath) {
  return (
    filePath.startsWith('packages/mobile/') ||
    filePath.startsWith('packages/shared/') ||
    filePath.startsWith('packages/shared-schema/') ||
    // deploy-app-web installs the root graph before exporting Expo web. The
    // workspace manifest owns linker policy, overrides and patch mappings, so
    // these root inputs can change the shipped browser bundle even when no
    // packages/mobile source file changed.
    filePath === 'pnpm-lock.yaml' ||
    filePath === 'pnpm-workspace.yaml' ||
    filePath === 'package.json' ||
    filePath.startsWith('patches/') ||
    filePath === 'scripts/build-expo-web-export.sh' ||
    // The export recipe shells out to this: it rewrites the shipped shell's
    // manifest href and the manifest's start_url/scope from the export's
    // baseUrl (W-24, #4438). A patcher-only change alters the artifact
    // app.boardsesh.com serves, so it has to redeploy the subdomain — and run
    // the post-deploy manifest smoke that would catch a bad patch.
    filePath === 'scripts/lib/patch-expo-web-pwa-manifest.mjs' ||
    // Everything deploy-app-web ships to the Pages project. Listed file by file
    // rather than as a `deploy/app-subdomain/` prefix because the rest of that
    // directory — README, tsconfig, vite config, __tests__ — is not deployed,
    // and a README edit should not redeploy the subdomain.
    filePath === 'deploy/app-subdomain/_headers' ||
    filePath === 'deploy/app-subdomain/_redirects' ||
    filePath === 'deploy/app-subdomain/_routes.json' ||
    filePath.startsWith('deploy/app-subdomain/functions/')
  );
}

function classifyChangedFiles(changedFiles) {
  const targets = { web: false, backend: false, app: false, cloudflare: false, staticAssets: false };

  for (const filePath of changedFiles) {
    if (isProductionDeployTestFile(filePath) || isProductionDeployWatchdogFile(filePath)) continue;
    if (isProductionDeployControlFile(filePath)) return { ...ALL_TARGETS };
    if (isBackendAffecting(filePath)) targets.backend = true;
    if (isWebAffecting(filePath)) targets.web = true;
    if (isAppAffecting(filePath)) targets.app = true;
    if (isCloudflareAffecting(filePath)) targets.cloudflare = true;
    if (isStaticAssetsAffecting(filePath)) targets.staticAssets = true;
  }

  return targets;
}

function createCliGit({ cwd = process.cwd() } = {}) {
  const runGit = (args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  return {
    commitExists(commitSha) {
      try {
        runGit(['cat-file', '-e', `${commitSha}^{commit}`]);
        return true;
      } catch {
        return false;
      }
    },
    isAncestor(ancestorSha, descendantSha) {
      try {
        runGit(['merge-base', '--is-ancestor', ancestorSha, descendantSha]);
        return true;
      } catch {
        return false;
      }
    },
    changedFiles(baseSha, headSha) {
      const output = runGit(['diff', '--name-only', baseSha, headSha]);
      return output === '' ? [] : output.split('\n').filter(Boolean);
    },
  };
}

function determineProductionDeployChanges({ eventName, headSha, currentRunId = '', runsPayload, git }) {
  if (eventName === 'workflow_dispatch') return fullDeploy('workflow_dispatch');

  const priorRun = selectLatestSuccessfulPriorRun(runsPayload, { currentRunId });
  if (!priorRun) return fullDeploy('missing-successful-baseline');

  const deploymentBaseSha = priorRun.head_sha.trim();
  const normalizedHeadSha = typeof headSha === 'string' ? headSha.trim() : '';
  if (!FULL_COMMIT_SHA_PATTERN.test(normalizedHeadSha) || normalizedHeadSha === ZERO_SHA) {
    return fullDeploy('missing-or-invalid-head-sha');
  }

  try {
    if (!git.commitExists(deploymentBaseSha) || !git.commitExists(normalizedHeadSha)) {
      return fullDeploy('unreachable-baseline-or-head');
    }
    if (!git.isAncestor(deploymentBaseSha, normalizedHeadSha)) {
      return fullDeploy('baseline-is-not-an-ancestor');
    }

    const changedFiles = git.changedFiles(deploymentBaseSha, normalizedHeadSha);
    const targets = classifyChangedFiles(changedFiles);
    return {
      ...targets,
      deploymentBaseSha,
      changedFiles,
      fullBuild: false,
      reason: 'cumulative-diff',
    };
  } catch {
    return fullDeploy('git-comparison-failed');
  }
}

function parseCliArguments(argv) {
  const options = {
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    headSha: process.env.GITHUB_SHA ?? '',
    currentRunId: process.env.GITHUB_RUN_ID ?? '',
    runsJsonPath: '',
    outputPath: process.env.GITHUB_OUTPUT ?? '',
  };

  for (let argumentIndex = 0; argumentIndex < argv.length; argumentIndex += 1) {
    const argument = argv[argumentIndex];
    const optionValue = argv[argumentIndex + 1];
    switch (argument) {
      case '--event':
        options.eventName = optionValue ?? '';
        argumentIndex += 1;
        break;
      case '--head':
        options.headSha = optionValue ?? '';
        argumentIndex += 1;
        break;
      case '--run-id':
        options.currentRunId = optionValue ?? '';
        argumentIndex += 1;
        break;
      case '--runs-json':
        options.runsJsonPath = optionValue ?? '';
        argumentIndex += 1;
        break;
      case '--output':
        options.outputPath = optionValue ?? '';
        argumentIndex += 1;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  return options;
}

function readRunsPayload(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function formatGitHubOutputs(result) {
  return [
    `web=${result.web}`,
    `backend=${result.backend}`,
    `app=${result.app}`,
    `cloudflare=${result.cloudflare}`,
    `static_assets=${result.staticAssets}`,
    `deployment_base_sha=${result.deploymentBaseSha}`,
  ].join('\n');
}

/** Human-readable target summary, derived from the emitted outputs so the two can't drift. */
function summariseTargets(result) {
  return formatGitHubOutputs(result)
    .split('\n')
    .filter((line) => !line.startsWith('deployment_base_sha='))
    .join('; ');
}

function runCli(argv) {
  const options = parseCliArguments(argv);
  const result = determineProductionDeployChanges({
    eventName: options.eventName,
    headSha: options.headSha,
    currentRunId: options.currentRunId,
    runsPayload: readRunsPayload(options.runsJsonPath),
    git: createCliGit(),
  });
  const outputs = `${formatGitHubOutputs(result)}\n`;

  if (options.outputPath) appendFileSync(options.outputPath, outputs, 'utf8');
  else process.stdout.write(outputs);

  console.error(
    `production-deploy-changes: ${result.reason}; base=${result.deploymentBaseSha || 'none'}; ` +
      // Derived from formatGitHubOutputs, not hand-listed: the two drifted apart
      // when `cloudflare` was added (#3837) and the deploy log then could not
      // say whether the Cloudflare apply had been targeted — precisely the
      // question you ask when that job misbehaves. Deriving it means a new
      // target shows up here for free.
      summariseTargets(result),
  );
  if (result.changedFiles.length > 0) {
    console.error(`Changed files since deployment baseline:\n${result.changedFiles.join('\n')}`);
  }
  return result;
}

if (process.argv[1] === scriptPath) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`production-deploy-changes: ${error.message}`);
    process.exit(1);
  }
}

export {
  classifyChangedFiles,
  summariseTargets,
  createCliGit,
  determineProductionDeployChanges,
  formatGitHubOutputs,
  isAppAffecting,
  isBackendAffecting,
  isProductionDeployControlFile,
  isProductionDeployTestFile,
  isProductionDeployWatchdogFile,
  isStaticAssetsAffecting,
  isWebAffecting,
  readRunsPayload,
  selectLatestSuccessfulPriorRun,
};
