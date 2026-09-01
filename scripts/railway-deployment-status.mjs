#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const SAFE_DEPLOYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = new Set(['BUILDING', 'DEPLOYING', 'INITIALIZING', 'NEEDS_APPROVAL', 'QUEUED', 'WAITING']);
const TERMINAL_STATUSES = new Set([
  'CANCELED',
  'CANCELLED',
  'CRASHED',
  'FAILED',
  'REMOVED',
  'REMOVING',
  'SKIPPED',
  'SLEEPING',
  'SUCCESS',
]);
const KNOWN_STATUSES = new Set([...ACTIVE_STATUSES, ...TERMINAL_STATUSES]);

class DeploymentImageValidationError extends Error {
  constructor(message, deployment) {
    super(message);
    this.name = 'DeploymentImageValidationError';
    this.deployment = deployment;
  }
}

class DeploymentCancellationError extends Error {
  constructor(deploymentId) {
    super('sole new Railway deployment was cancelled; quarantining its ID for manual reconciliation');
    this.name = 'DeploymentCancellationError';
    this.deploymentId = deploymentId;
  }
}

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
  const rawStatus = String(deployment?.status ?? deployment?.deployment?.status ?? '').trim();
  const wrappedCancellation = rawStatus.match(/^Other\("(CANCELED|CANCELLED)"\)$/);
  return (wrappedCancellation?.[1] ?? rawStatus).toUpperCase();
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

function getDeploymentImage(deployment) {
  return String(deployment?.meta?.image ?? deployment?.deployment?.meta?.image ?? '').trim();
}

function parseTimestamp(value, label) {
  const parsed = Date.parse(value);
  if (!value || Number.isNaN(parsed)) {
    throw new Error(`${label} has an invalid createdAt timestamp`);
  }
  return parsed;
}

function normalizeExpectedImage(rawExpectedImage) {
  const expectedImage = String(rawExpectedImage ?? '');
  if (!expectedImage || expectedImage !== expectedImage.trim() || /\s/.test(expectedImage)) {
    throw new Error('EXPECTED_IMAGE must be a non-empty image reference without whitespace');
  }
  return expectedImage;
}

function normalizeDeploymentList(payload) {
  const seenIds = new Set();
  return asDeploymentList(payload).map((deployment) => {
    const id = getDeploymentId(deployment);
    if (!SAFE_DEPLOYMENT_ID.test(id)) {
      throw new Error('Railway deployment list contained a missing or unsafe deployment ID');
    }
    if (seenIds.has(id)) {
      throw new Error(`Railway deployment list contained duplicate deployment ID ${id}`);
    }
    seenIds.add(id);

    const createdAt = getDeploymentCreatedAt(deployment);
    const status = getDeploymentStatus(deployment);
    if (!/^[A-Z_]+$/.test(status)) {
      throw new Error(`Railway deployment ${id} returned an invalid status`);
    }
    return {
      id,
      status,
      createdAt,
      createdAtMs: parseTimestamp(createdAt, `Railway deployment ${id}`),
      image: getDeploymentImage(deployment),
    };
  });
}

function requireExpectedImage(deployment, expectedImage, label) {
  if (!deployment.image) {
    throw new DeploymentImageValidationError(`${label} did not report meta.image`, deployment);
  }
  if (deployment.image !== expectedImage) {
    throw new DeploymentImageValidationError(`${label} image did not match EXPECTED_IMAGE`, deployment);
  }
}

function shellValue(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function printEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    console.log(`${key}=${shellValue(value ?? '')}`);
  }
}

function capturePreviousDeployment(payload, rawExpectedImage) {
  const expectedImage = normalizeExpectedImage(rawExpectedImage);
  const deployments = normalizeDeploymentList(payload);
  const unknown = deployments.find((deployment) => !KNOWN_STATUSES.has(deployment.status));
  if (unknown) {
    throw new Error(`Railway deployment ${unknown.id} returned unknown status ${unknown.status}`);
  }
  const sleeping = deployments.find((deployment) => deployment.status === 'SLEEPING');
  if (sleeping) {
    throw new Error('Railway redeploy recovery does not support services with application sleeping enabled');
  }
  const inFlight = deployments.find((deployment) => ACTIVE_STATUSES.has(deployment.status));
  if (inFlight) {
    throw new Error(`Railway service is not quiet: deployment ${inFlight.id} is still ${inFlight.status}`);
  }
  const successful = deployments
    .filter((deployment) => deployment.status === 'SUCCESS')
    .sort((left, right) => right.createdAtMs - left.createdAtMs);

  if (successful.length === 0) {
    throw new Error('could not capture a previous successful Railway deployment');
  }
  if (successful.length > 1 && successful[0].createdAtMs === successful[1].createdAtMs) {
    throw new Error('latest successful Railway deployment is ambiguous because createdAt timestamps are tied');
  }

  const previous = successful[0];
  requireExpectedImage(previous, expectedImage, 'previous successful Railway deployment');
  return {
    id: previous.id,
    createdAt: previous.createdAt,
    status: previous.status,
    image: previous.image,
    baselineIds: deployments.map((deployment) => deployment.id),
  };
}

function parseSafeIdSet(rawIds, variableName) {
  const ids = String(rawIds ?? '')
    .split(',')
    .filter(Boolean);
  if (ids.length === 0 || ids.some((id) => !SAFE_DEPLOYMENT_ID.test(id))) {
    throw new Error(`${variableName} must contain safe Railway deployment IDs`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${variableName} contains duplicate deployment IDs`);
  }
  return new Set(ids);
}

function findNewDeployment(payload, options) {
  const expectedImage = normalizeExpectedImage(options.expectedImage);
  const deployments = normalizeDeploymentList(payload);
  const lockedId = String(options.lockedId ?? '').trim();
  const observedCancelledId = String(options.observedCancelledId ?? '').trim();
  const baselineIds = parseSafeIdSet(options.baselineIds, 'BASELINE_DEPLOYMENT_IDS');
  // Baseline rows do not need to remain in Railway's bounded response. Set
  // membership still identifies every returned post-capture ID if old rows
  // age out while this action waits for the redeploy.
  const postBaseline = deployments.filter((deployment) => !baselineIds.has(deployment.id));

  if (lockedId) {
    if (observedCancelledId) {
      throw new Error('cancelled-deployment quarantine cannot coexist with a locked deployment');
    }
    if (!SAFE_DEPLOYMENT_ID.test(lockedId)) {
      throw new Error('LOCKED_DEPLOYMENT_ID is unsafe');
    }
    const locked = postBaseline.filter((deployment) => deployment.id === lockedId);
    if (locked.length !== 1) {
      throw new Error('locked Railway deployment disappeared from the deployment list');
    }
    if (postBaseline.length !== 1) {
      throw new Error('a concurrent Railway deployment appeared after the redeploy lock');
    }
    requireExpectedImage(locked[0], expectedImage, 'locked Railway deployment');
    return locked[0];
  }

  if (observedCancelledId) {
    if (!SAFE_DEPLOYMENT_ID.test(observedCancelledId)) {
      throw new Error('OBSERVED_CANCELLED_DEPLOYMENT_ID is unsafe');
    }
    if (
      postBaseline.length !== 1 ||
      postBaseline[0].id !== observedCancelledId ||
      (postBaseline[0].status !== 'CANCELED' && postBaseline[0].status !== 'CANCELLED')
    ) {
      throw new Error('Railway deployment set changed after a cancellation was quarantined; reconcile manually');
    }
    throw new DeploymentCancellationError(observedCancelledId);
  }

  if (postBaseline.length === 0) {
    return {
      id: '',
      status: '',
      createdAt: '',
      createdAtMs: Number.NaN,
      image: '',
    };
  }

  if (postBaseline.length !== 1) {
    throw new Error('Railway redeploy discovery is ambiguous because multiple new deployments appeared');
  }

  const captureStartedAt = parseTimestamp(String(options.captureStartedAt ?? ''), 'CAPTURE_STARTED_AT');
  const candidate = postBaseline[0];
  // Railway and the GitHub runner do not share a clock. Keep a generous skew
  // allowance while still rejecting an old row that was absent from the
  // bounded baseline page and would otherwise look newly created.
  if (candidate.createdAtMs + 5 * 60 * 1000 < captureStartedAt) {
    throw new Error('new Railway deployment predates the baseline capture');
  }
  if (candidate.status === 'CANCELED' || candidate.status === 'CANCELLED') {
    throw new DeploymentCancellationError(candidate.id);
  }
  requireExpectedImage(candidate, expectedImage, 'new Railway deployment');
  return candidate;
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
    const previous = capturePreviousDeployment(payload, process.env.EXPECTED_IMAGE);
    printEnv({
      PREVIOUS_DEPLOYMENT_ID: previous.id,
      PREVIOUS_DEPLOYMENT_CREATED_AT: previous.createdAt,
      PREVIOUS_DEPLOYMENT_STATUS: previous.status,
      PREVIOUS_DEPLOYMENT_IMAGE: previous.image,
      BASELINE_DEPLOYMENT_IDS: previous.baselineIds.join(','),
    });
    return;
  }

  if (command === 'find-new') {
    let deployment;
    try {
      deployment = findNewDeployment(payload, {
        baselineIds: process.env.BASELINE_DEPLOYMENT_IDS,
        expectedImage: process.env.EXPECTED_IMAGE,
        lockedId: process.env.LOCKED_DEPLOYMENT_ID,
        captureStartedAt: process.env.CAPTURE_STARTED_AT,
        observedCancelledId: process.env.OBSERVED_CANCELLED_DEPLOYMENT_ID,
      });
    } catch (error) {
      if (error instanceof DeploymentCancellationError) {
        printEnv({ OBSERVED_CANCELLED_DEPLOYMENT_ID: error.deploymentId });
      }
      if (error instanceof DeploymentImageValidationError) {
        printEnv({
          CURRENT_ID: error.deployment.id,
          CURRENT_STATUS: error.deployment.status,
          CURRENT_CREATED_AT: error.deployment.createdAt,
          CURRENT_IMAGE: error.deployment.image,
        });
      }
      throw error;
    }
    printEnv({
      CURRENT_ID: deployment.id,
      CURRENT_STATUS: deployment.status,
      CURRENT_CREATED_AT: deployment.createdAt,
      CURRENT_IMAGE: deployment.image,
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
  ACTIVE_STATUSES,
  asDeploymentList,
  capturePreviousDeployment,
  findNewDeployment,
  getDeploymentCreatedAt,
  getDeploymentId,
  getDeploymentImage,
  getDeploymentStatus,
  normalizeExpectedImage,
};
