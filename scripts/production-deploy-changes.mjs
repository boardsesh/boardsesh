#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const ZERO_SHA = '0000000000000000000000000000000000000000';
const ALL_TARGETS = Object.freeze({ web: true, backend: true, app: true });
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

function isProductionDeployTestFile(filePath) {
  return (
    filePath === 'scripts/production-backend-smoke.test.mjs' ||
    filePath === 'scripts/production-deploy-changes.test.mjs'
  );
}

function isBackendAffecting(filePath) {
  return (
    filePath.startsWith('packages/') ||
    filePath === 'Dockerfile.backend' ||
    filePath === 'scripts/create-service-docker-context.mjs' ||
    filePath === 'scripts/production-backend-smoke.mjs' ||
    filePath === 'scripts/railway-deployment-status.mjs' ||
    filePath === 'railway.toml' ||
    filePath === 'bun.lock' ||
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
    isProductionDeployTestFile(filePath)
  );
}

function isAppAffecting(filePath) {
  return (
    filePath.startsWith('packages/mobile/') ||
    filePath.startsWith('packages/shared/') ||
    filePath.startsWith('packages/shared-schema/') ||
    filePath === 'scripts/build-expo-web-export.sh' ||
    filePath === 'deploy/app-subdomain/_headers' ||
    filePath === 'deploy/app-subdomain/_redirects'
  );
}

function classifyChangedFiles(changedFiles) {
  const targets = { web: false, backend: false, app: false };

  for (const filePath of changedFiles) {
    if (isProductionDeployTestFile(filePath)) continue;
    if (isProductionDeployControlFile(filePath)) return { ...ALL_TARGETS };
    if (isBackendAffecting(filePath)) targets.backend = true;
    if (isWebAffecting(filePath)) targets.web = true;
    if (isAppAffecting(filePath)) targets.app = true;
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
    `deployment_base_sha=${result.deploymentBaseSha}`,
  ].join('\n');
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
      `web=${result.web}; backend=${result.backend}; app=${result.app}`,
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
  createCliGit,
  determineProductionDeployChanges,
  formatGitHubOutputs,
  isAppAffecting,
  isBackendAffecting,
  isProductionDeployControlFile,
  isProductionDeployTestFile,
  isWebAffecting,
  readRunsPayload,
  selectLatestSuccessfulPriorRun,
};
