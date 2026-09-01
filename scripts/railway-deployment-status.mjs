#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);

function parseJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`failed to parse Railway deployment JSON from ${filePath}: ${error.message}`);
  }
}

function asDeploymentList(payload) {
  if (Array.isArray(payload)) return payload;

  const candidateLists = [
    payload?.deployments,
    payload?.items,
    payload?.data,
    payload?.data?.deployments,
    payload?.data?.items,
    payload?.project?.deployments,
  ];
  const list = candidateLists.find((candidate) => Array.isArray(candidate));
  if (!list) {
    throw new Error('Railway deployment list JSON did not contain an array of deployments');
  }
  return list;
}

function getDeploymentId(deployment) {
  return String(deployment?.id ?? deployment?.deploymentId ?? deployment?.deployment?.id ?? '').trim();
}

function getDeploymentStatus(deployment) {
  return String(deployment?.status ?? deployment?.deployment?.status ?? '')
    .trim()
    .toUpperCase();
}

function getDeploymentCreatedAt(deployment) {
  return String(
    deployment?.createdAt ??
      deployment?.created_at ??
      deployment?.createdTimestamp ??
      deployment?.deployment?.createdAt ??
      deployment?.deployment?.created_at ??
      deployment?.deployment?.createdTimestamp ??
      '',
  ).trim();
}

function parseTimestamp(value) {
  if (!value) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function shellValue(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function printEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    console.log(`${key}=${shellValue(value ?? '')}`);
  }
}

function capturePreviousDeployment(payload) {
  const deployments = asDeploymentList(payload);
  const deployment = deployments[0];
  const id = getDeploymentId(deployment);
  if (!id) {
    throw new Error('could not capture previous Railway deployment ID from deployment list');
  }
  return {
    id,
    createdAt: getDeploymentCreatedAt(deployment),
    status: getDeploymentStatus(deployment),
  };
}

function isNewerThanPrevious(candidate, candidateIndex, previous) {
  const candidateId = getDeploymentId(candidate);
  if (!candidateId || candidateId === previous.id) return false;

  const candidateCreatedAt = parseTimestamp(getDeploymentCreatedAt(candidate));
  const previousCreatedAt = parseTimestamp(previous.createdAt);
  if (!Number.isNaN(candidateCreatedAt) && !Number.isNaN(previousCreatedAt)) {
    return candidateCreatedAt > previousCreatedAt;
  }

  if (previous.index >= 0) {
    return candidateIndex < previous.index;
  }

  // Timestamps were unusable AND the previous deployment has aged out of the
  // (10-item) deployment list entirely. It was captured as the newest
  // deployment before the redeploy that started this poll, so anything the
  // API is still returning must postdate it — the alternative (returning
  // false here) never finds a "newer" deployment and exhausts every poll
  // attempt even after the redeploy has already succeeded.
  return true;
}

function findNewDeployment(payload, previous) {
  if (!previous.id) {
    throw new Error('PREVIOUS_DEPLOYMENT_ID is required before polling Railway redeploy status');
  }

  const deployments = asDeploymentList(payload);
  const previousIndex = deployments.findIndex((deployment) => getDeploymentId(deployment) === previous.id);
  const previousWithIndex = { ...previous, index: previousIndex };
  const candidates = deployments.filter((candidate, index) => isNewerThanPrevious(candidate, index, previousWithIndex));

  if (candidates.length === 0) {
    return { id: '', status: '', createdAt: '' };
  }

  // Railway marks a queued deployment CANCELLED when a newer one supersedes
  // it. If both the cancelled entry and its successor are newer than the
  // captured previous deployment, prefer the non-cancelled one — otherwise a
  // superseded queue entry can mask the redeploy that actually ran, and the
  // poller would sit on CANCELLED until it times out even after the real
  // deployment reached SUCCESS.
  const deployment = candidates.find((candidate) => getDeploymentStatus(candidate) !== 'CANCELLED') ?? candidates[0];

  return {
    id: getDeploymentId(deployment),
    status: getDeploymentStatus(deployment),
    createdAt: getDeploymentCreatedAt(deployment),
  };
}

function runCli(argv) {
  const [command, jsonPath] = argv;
  if (!command || !jsonPath) {
    throw new Error(
      'usage: node scripts/railway-deployment-status.mjs <capture-previous|find-new> <railway-json-file>',
    );
  }

  const payload = parseJsonFile(jsonPath);
  if (command === 'capture-previous') {
    const previous = capturePreviousDeployment(payload);
    printEnv({
      PREVIOUS_DEPLOYMENT_ID: previous.id,
      PREVIOUS_DEPLOYMENT_CREATED_AT: previous.createdAt,
      PREVIOUS_DEPLOYMENT_STATUS: previous.status,
    });
    return;
  }

  if (command === 'find-new') {
    const deployment = findNewDeployment(payload, {
      id: process.env.PREVIOUS_DEPLOYMENT_ID ?? '',
      createdAt: process.env.PREVIOUS_DEPLOYMENT_CREATED_AT ?? '',
    });
    printEnv({
      CURRENT_ID: deployment.id,
      CURRENT_STATUS: deployment.status,
      CURRENT_CREATED_AT: deployment.createdAt,
    });
    return;
  }

  throw new Error(`unknown command ${command}`);
}

if (process.argv[1] === scriptPath) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`railway-deployment-status: ${error.message}`);
    process.exit(1);
  }
}

export {
  asDeploymentList,
  capturePreviousDeployment,
  findNewDeployment,
  getDeploymentCreatedAt,
  getDeploymentId,
  getDeploymentStatus,
};
