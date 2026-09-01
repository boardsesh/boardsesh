#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const SAFE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPLOYMENT_LIST_LIMIT = 100;
const ACTIVE_STATUSES = new Set(['BUILDING', 'DEPLOYING', 'INITIALIZING', 'NEEDS_APPROVAL', 'QUEUED', 'WAITING']);
const FAILED_STATUSES = new Set([
  'CANCELED',
  'CANCELLED',
  'CRASHED',
  'FAILED',
  'REMOVED',
  'REMOVING',
  'SKIPPED',
  'SLEEPING',
]);
const KNOWN_STATUSES = new Set(['SUCCESS', ...ACTIVE_STATUSES, ...FAILED_STATUSES]);
const ROLLBACK_TARGET_STATUSES = new Set(['REMOVED', 'SUCCESS']);

const PROJECT_TOKEN_QUERY = `
  query ProjectTokenScopeForVerifiedRollback {
    projectToken {
      projectId
      environmentId
    }
  }
`;

const DEPLOYMENT_QUERY = `
  query DeploymentForVerifiedRollback($id: String!) {
    deployment(id: $id) {
      id
      status
      serviceId
      environmentId
      projectId
      createdAt
      canRollback
      meta
    }
  }
`;

const DEPLOYMENTS_QUERY = `
  query ServiceDeploymentsForVerifiedRollback($input: DeploymentListInput!, $first: Int!) {
    deployments(input: $input, first: $first) {
      edges {
        node {
          id
          status
          serviceId
          environmentId
          projectId
          createdAt
          canRollback
          meta
        }
      }
    }
  }
`;

const SERVICE_INSTANCE_STATE_QUERY = `
  query ServiceInstanceStateForVerifiedRollback($environmentId: String!, $serviceId: String!) {
    serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
      latestDeployment {
        id
        status
        serviceId
        environmentId
        projectId
        createdAt
        canRollback
        meta
      }
      activeDeployments {
        id
        status
        serviceId
        environmentId
        projectId
        createdAt
        canRollback
        meta
      }
    }
  }
`;

// Railway's live schema returns Boolean!, not a Deployment. Keep this scalar
// selection-free: adding a selection set makes the request fail validation.
const ROLLBACK_MUTATION = `
  mutation VerifiedDeploymentRollback($id: String!) {
    deploymentRollback(id: $id)
  }
`;

class RailwayReadError extends Error {}

function requireSafeId(rawId, label) {
  const id = String(rawId ?? '')
    .trim()
    .toLowerCase();
  if (!SAFE_ID.test(id)) throw new Error(`${label} must be a Railway UUID`);
  return id;
}

function requireBoundedInteger(value, label, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
}

function deploymentImage(rawDeployment) {
  const rawImage = rawDeployment?.meta?.image;
  return typeof rawImage === 'string' ? rawImage.trim() : '';
}

function normalizeDeployment(rawDeployment, label) {
  if (!rawDeployment || typeof rawDeployment !== 'object' || Array.isArray(rawDeployment)) {
    throw new RailwayReadError(`Railway ${label} response did not contain a deployment`);
  }

  const status = String(rawDeployment.status ?? '')
    .trim()
    .toUpperCase();
  if (!KNOWN_STATUSES.has(status)) {
    throw new Error(`Railway ${label} returned unknown status ${status || '<empty>'}`);
  }

  const createdAt = String(rawDeployment.createdAt ?? '').trim();
  const createdAtMs = Date.parse(createdAt);
  if (!createdAt || Number.isNaN(createdAtMs)) {
    throw new Error(`Railway ${label} returned an invalid createdAt timestamp`);
  }

  return {
    id: requireSafeId(rawDeployment.id, `${label} deployment ID`),
    serviceId: requireSafeId(rawDeployment.serviceId, `${label} service ID`),
    environmentId: requireSafeId(rawDeployment.environmentId, `${label} environment ID`),
    projectId: requireSafeId(rawDeployment.projectId, `${label} project ID`),
    status,
    createdAt,
    createdAtMs,
    canRollback: rawDeployment.canRollback,
    image: deploymentImage(rawDeployment),
  };
}

function assertDeploymentScope(deployment, scope, label) {
  if (deployment.serviceId !== scope.serviceId) {
    throw new Error(`Railway ${label} belongs to a different service`);
  }
  if (deployment.environmentId !== scope.environmentId) {
    throw new Error(`Railway ${label} belongs to a different environment`);
  }
  if (deployment.projectId !== scope.projectId) {
    throw new Error(`Railway ${label} belongs to a different project`);
  }
}

async function requestGraphql({ fetchImpl, token, query, variables, operation, requestTimeoutMs = 30_000 }) {
  requireBoundedInteger(requestTimeoutMs, 'requestTimeoutMs', 300_000);
  let response;
  try {
    response = await fetchImpl(RAILWAY_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Project-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch {
    throw new RailwayReadError(`Railway ${operation} request failed`);
  }

  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? response.status : 'unknown';
    throw new RailwayReadError(`Railway ${operation} returned HTTP ${status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new RailwayReadError(`Railway ${operation} returned invalid JSON`);
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new RailwayReadError(`Railway ${operation} returned GraphQL errors`);
  }
  if (!payload?.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    throw new RailwayReadError(`Railway ${operation} response did not contain data`);
  }
  return payload.data;
}

async function queryProjectScope({ fetchImpl, token, requestTimeoutMs }) {
  const data = await requestGraphql({
    fetchImpl,
    token,
    query: PROJECT_TOKEN_QUERY,
    variables: {},
    operation: 'project token query',
    requestTimeoutMs,
  });
  if (!data.projectToken || typeof data.projectToken !== 'object' || Array.isArray(data.projectToken)) {
    throw new RailwayReadError('Railway project token query response did not contain projectToken');
  }
  return {
    projectId: requireSafeId(data.projectToken.projectId, 'project token project ID'),
    environmentId: requireSafeId(data.projectToken.environmentId, 'project token environment ID'),
  };
}

async function queryDeployment({ fetchImpl, token, deploymentId, operation, requestTimeoutMs }) {
  const data = await requestGraphql({
    fetchImpl,
    token,
    query: DEPLOYMENT_QUERY,
    variables: { id: deploymentId },
    operation,
    requestTimeoutMs,
  });
  return normalizeDeployment(data.deployment, operation);
}

async function queryServiceDeployments({ fetchImpl, token, scope, operation, requestTimeoutMs }) {
  const data = await requestGraphql({
    fetchImpl,
    token,
    query: DEPLOYMENTS_QUERY,
    variables: {
      input: {
        environmentId: scope.environmentId,
        includeDeleted: true,
        projectId: scope.projectId,
        serviceId: scope.serviceId,
      },
      first: DEPLOYMENT_LIST_LIMIT,
    },
    operation,
    requestTimeoutMs,
  });

  const edges = data.deployments?.edges;
  if (!Array.isArray(edges)) {
    throw new RailwayReadError(`Railway ${operation} response did not contain deployment edges`);
  }
  if (edges.length > DEPLOYMENT_LIST_LIMIT) {
    throw new Error(`Railway ${operation} returned too many deployments`);
  }

  const seenIds = new Set();
  return edges.map((edge, index) => {
    const deployment = normalizeDeployment(edge?.node, `${operation} item ${index + 1}`);
    if (seenIds.has(deployment.id)) {
      throw new Error(`Railway ${operation} returned duplicate deployment IDs`);
    }
    seenIds.add(deployment.id);
    assertDeploymentScope(deployment, scope, `${operation} item ${index + 1}`);
    return deployment;
  });
}

async function queryServiceInstanceState({ fetchImpl, token, scope, operation, requestTimeoutMs }) {
  const data = await requestGraphql({
    fetchImpl,
    token,
    query: SERVICE_INSTANCE_STATE_QUERY,
    variables: {
      environmentId: scope.environmentId,
      serviceId: scope.serviceId,
    },
    operation,
    requestTimeoutMs,
  });
  const serviceInstance = data.serviceInstance;
  if (!serviceInstance || typeof serviceInstance !== 'object' || Array.isArray(serviceInstance)) {
    throw new RailwayReadError(`Railway ${operation} response did not contain a service instance`);
  }

  const latest = normalizeDeployment(serviceInstance.latestDeployment, `${operation} latest deployment`);
  assertDeploymentScope(latest, scope, `${operation} latest deployment`);
  if (!Array.isArray(serviceInstance.activeDeployments)) {
    throw new RailwayReadError(`Railway ${operation} response did not contain active deployments`);
  }
  const seenIds = new Set();
  const active = serviceInstance.activeDeployments.map((rawDeployment, index) => {
    const deployment = normalizeDeployment(rawDeployment, `${operation} active deployment ${index + 1}`);
    if (seenIds.has(deployment.id)) {
      throw new Error(`Railway ${operation} returned duplicate active deployment IDs`);
    }
    seenIds.add(deployment.id);
    assertDeploymentScope(deployment, scope, `${operation} active deployment ${index + 1}`);
    return deployment;
  });
  return { active, latest };
}

async function readWithRetries({ read, maxConsecutiveReadErrors, pollIntervalMs, sleepImpl }) {
  for (let attempt = 1; attempt <= maxConsecutiveReadErrors; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof RailwayReadError) || attempt === maxConsecutiveReadErrors) throw error;
      await sleepImpl(pollIntervalMs);
    }
  }
  throw new Error('unreachable Railway read retry state');
}

function validatePreMutationState({ deployments, expectedCurrent, scope, target }) {
  assertDeploymentScope(target, scope, 'rollback target');
  assertDeploymentScope(expectedCurrent, scope, 'expected current deployment');

  if (!ROLLBACK_TARGET_STATUSES.has(target.status)) {
    throw new Error(`Railway rollback target has unsafe status ${target.status}`);
  }
  if (target.canRollback !== true) {
    throw new Error('Railway rollback target is not currently rollback-capable');
  }
  if (!target.image) {
    throw new Error('Railway rollback target did not report meta.image');
  }
  if (expectedCurrent.id === target.id) {
    throw new Error('Expected current deployment must differ from the rollback target');
  }
  if (expectedCurrent.status === 'CANCELED' || expectedCurrent.status === 'CANCELLED') {
    throw new Error('Expected current deployment is cancelled; automatic rollback is unsafe');
  }
  if (expectedCurrent.createdAtMs <= target.createdAtMs) {
    throw new Error('Expected current deployment is not newer than the rollback target');
  }

  const targetFromList = deployments.filter((deployment) => deployment.id === target.id);
  if (targetFromList.length !== 1) {
    throw new Error('Rollback target was not present exactly once in the service deployment list');
  }
  if (
    targetFromList[0].createdAtMs !== target.createdAtMs ||
    targetFromList[0].image !== target.image ||
    targetFromList[0].canRollback !== true ||
    !ROLLBACK_TARGET_STATUSES.has(targetFromList[0].status)
  ) {
    throw new Error('Rollback target disagreed between exact and list queries');
  }

  const currentFromList = deployments.filter((deployment) => deployment.id === expectedCurrent.id);
  if (currentFromList.length !== 1) {
    throw new Error('Expected current deployment was not present exactly once in the service deployment list');
  }
  if (currentFromList[0].createdAtMs !== expectedCurrent.createdAtMs) {
    throw new Error('Expected current deployment timestamp disagreed between exact and list queries');
  }
  if (currentFromList[0].image !== expectedCurrent.image) {
    throw new Error('Expected current deployment image disagreed between exact and list queries');
  }
  if (currentFromList[0].status !== expectedCurrent.status) {
    throw new Error('Expected current deployment status disagreed between exact and list queries');
  }

  const competingDeployments = deployments.filter(
    (deployment) =>
      deployment.id !== target.id &&
      deployment.id !== expectedCurrent.id &&
      (ACTIVE_STATUSES.has(deployment.status) ||
        (deployment.status === 'SUCCESS' && deployment.createdAtMs > target.createdAtMs)),
  );
  if (competingDeployments.length > 0) {
    throw new Error('Rollback preflight found a competing deployment between the target and expected current');
  }

  const newestCreatedAtMs = Math.max(...deployments.map((deployment) => deployment.createdAtMs));
  const newest = deployments.filter((deployment) => deployment.createdAtMs === newestCreatedAtMs);
  if (newest.length !== 1 || newest[0].id !== expectedCurrent.id) {
    throw new Error('Expected current deployment is not the sole newest service deployment');
  }

  return new Set(deployments.map((deployment) => deployment.id));
}

function deploymentsAfterBaseline(deployments, baselineIds) {
  return deployments.filter((deployment) => !baselineIds.has(deployment.id));
}

function validateLockedRollback({ deployments, baselineIds, lockedDeploymentId, polled, scope, targetImage }) {
  assertDeploymentScope(polled, scope, 'polled rollback deployment');
  if (polled.id !== lockedDeploymentId) {
    throw new Error('Railway rollback poll returned the wrong deployment');
  }
  if (polled.image !== targetImage) {
    throw new Error('Railway rollback deployment image did not match the target image');
  }

  const postBaseline = deploymentsAfterBaseline(deployments, baselineIds);
  if (postBaseline.length !== 1 || postBaseline[0].id !== lockedDeploymentId) {
    throw new Error('Railway rollback verification found a concurrent post-baseline deployment');
  }
  const listedRollback = postBaseline[0];
  if (listedRollback.createdAtMs !== polled.createdAtMs) {
    throw new Error('Railway rollback deployment timestamp disagreed between exact and list queries');
  }
  if (listedRollback.image !== targetImage) {
    throw new Error('Railway listed rollback deployment image did not match the target image');
  }
  return listedRollback;
}

function rollbackIsCurrent({ serviceState, baselineIds, lockedDeploymentId }) {
  if (serviceState.latest.id !== lockedDeploymentId) {
    throw new Error('Railway rollback deployment is not the service instance latest deployment');
  }
  if (FAILED_STATUSES.has(serviceState.latest.status)) {
    throw new Error(`Railway service instance latest deployment reached terminal status ${serviceState.latest.status}`);
  }
  if (serviceState.latest.status !== 'SUCCESS') {
    return false;
  }
  const unexpectedActive = serviceState.active.filter(
    (deployment) => deployment.id !== lockedDeploymentId && !baselineIds.has(deployment.id),
  );
  if (unexpectedActive.length > 0) {
    throw new Error('Railway service instance reported a concurrent active deployment');
  }
  if (serviceState.active.length !== 1 || serviceState.active[0].id !== lockedDeploymentId) {
    return false;
  }
  if (FAILED_STATUSES.has(serviceState.active[0].status)) {
    throw new Error(`Railway active rollback deployment reached terminal status ${serviceState.active[0].status}`);
  }
  if (serviceState.active[0].status !== 'SUCCESS') {
    return false;
  }
  return true;
}

async function rollbackDeployment({
  expectedCurrentDeploymentId: rawExpectedCurrentDeploymentId,
  fetchImpl = fetch,
  maxConsecutiveReadErrors = 3,
  maxPollAttempts = 90,
  pollIntervalMs = 10_000,
  requestTimeoutMs = 30_000,
  serviceId: rawServiceId,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  targetDeploymentId: rawTargetDeploymentId,
  token,
}) {
  const serviceId = requireSafeId(rawServiceId, 'RAILWAY_SERVICE_ID');
  const targetDeploymentId = requireSafeId(rawTargetDeploymentId, 'TARGET_DEPLOYMENT_ID');
  const expectedCurrentDeploymentId = requireSafeId(rawExpectedCurrentDeploymentId, 'EXPECTED_CURRENT_DEPLOYMENT_ID');
  if (expectedCurrentDeploymentId === targetDeploymentId) {
    throw new Error('EXPECTED_CURRENT_DEPLOYMENT_ID must differ from TARGET_DEPLOYMENT_ID');
  }
  if (!String(token ?? '').trim()) throw new Error('RAILWAY_TOKEN is required');
  requireBoundedInteger(maxConsecutiveReadErrors, 'maxConsecutiveReadErrors', 10);
  requireBoundedInteger(maxPollAttempts, 'maxPollAttempts', 360);
  requireBoundedInteger(pollIntervalMs, 'pollIntervalMs', 60_000);
  requireBoundedInteger(requestTimeoutMs, 'requestTimeoutMs', 300_000);

  const readOptions = { maxConsecutiveReadErrors, pollIntervalMs, sleepImpl };
  const projectScope = await readWithRetries({
    ...readOptions,
    read: () => queryProjectScope({ fetchImpl, token, requestTimeoutMs }),
  });
  const scope = { ...projectScope, serviceId };
  const target = await readWithRetries({
    ...readOptions,
    read: () =>
      queryDeployment({
        fetchImpl,
        token,
        deploymentId: targetDeploymentId,
        operation: 'rollback target query',
        requestTimeoutMs,
      }),
  });
  if (target.id !== targetDeploymentId) {
    throw new Error('Railway rollback target query returned the wrong deployment');
  }

  const expectedCurrent = await readWithRetries({
    ...readOptions,
    read: () =>
      queryDeployment({
        fetchImpl,
        token,
        deploymentId: expectedCurrentDeploymentId,
        operation: 'expected current deployment query',
        requestTimeoutMs,
      }),
  });
  if (expectedCurrent.id !== expectedCurrentDeploymentId) {
    throw new Error('Railway expected current query returned the wrong deployment');
  }

  // This is deliberately the final read before the mutation. Its IDs form the
  // fresh baseline used to detect every deployment Railway creates afterwards.
  const baselineDeployments = await readWithRetries({
    ...readOptions,
    read: () =>
      queryServiceDeployments({
        fetchImpl,
        token,
        scope,
        operation: 'pre-mutation service deployment list',
        requestTimeoutMs,
      }),
  });
  const baselineIds = validatePreMutationState({
    deployments: baselineDeployments,
    expectedCurrent,
    scope,
    target,
  });

  // Never retry this mutation after an ambiguous response. Railway may already
  // have accepted it, and a second call would create another deployment.
  const mutationData = await requestGraphql({
    fetchImpl,
    token,
    query: ROLLBACK_MUTATION,
    variables: { id: targetDeploymentId },
    operation: 'rollback mutation',
    requestTimeoutMs,
  });
  if (mutationData.deploymentRollback !== true) {
    throw new Error('Railway rollback mutation was not accepted');
  }

  let consecutiveReadErrors = 0;
  let lockedDeploymentId = '';
  for (let attempt = 1; attempt <= maxPollAttempts; attempt += 1) {
    try {
      if (!lockedDeploymentId) {
        const discoveryDeployments = await queryServiceDeployments({
          fetchImpl,
          token,
          scope,
          operation: 'rollback discovery list',
          requestTimeoutMs,
        });
        const discovered = deploymentsAfterBaseline(discoveryDeployments, baselineIds);
        if (discovered.length === 0) {
          consecutiveReadErrors = 0;
          await sleepImpl(pollIntervalMs);
          continue;
        }
        if (discovered.length !== 1) {
          throw new Error('Railway rollback discovery found concurrent post-baseline deployments');
        }
        lockedDeploymentId = discovered[0].id;
      }

      const polled = await queryDeployment({
        fetchImpl,
        token,
        deploymentId: lockedDeploymentId,
        operation: 'rollback status query',
        requestTimeoutMs,
      });
      const verificationDeployments = await queryServiceDeployments({
        fetchImpl,
        token,
        scope,
        operation: 'rollback verification list',
        requestTimeoutMs,
      });
      const listedRollback = validateLockedRollback({
        deployments: verificationDeployments,
        baselineIds,
        lockedDeploymentId,
        polled,
        scope,
        targetImage: target.image,
      });

      if (FAILED_STATUSES.has(polled.status) || FAILED_STATUSES.has(listedRollback.status)) {
        const terminalStatus = FAILED_STATUSES.has(listedRollback.status) ? listedRollback.status : polled.status;
        throw new Error(`Railway rollback deployment reached terminal status ${terminalStatus}`);
      }
      if (polled.status === 'SUCCESS' && listedRollback.status === 'SUCCESS') {
        const serviceState = await queryServiceInstanceState({
          fetchImpl,
          token,
          scope,
          operation: 'rollback service instance verification',
          requestTimeoutMs,
        });
        if (
          rollbackIsCurrent({
            serviceState,
            baselineIds,
            lockedDeploymentId,
          })
        ) {
          return { deploymentId: lockedDeploymentId, image: target.image };
        }
      }
      consecutiveReadErrors = 0;
      if (
        polled.status !== 'SUCCESS' &&
        !ACTIVE_STATUSES.has(polled.status) &&
        listedRollback.status !== 'SUCCESS' &&
        !ACTIVE_STATUSES.has(listedRollback.status)
      ) {
        throw new Error('Railway rollback deployment returned an unsafe status transition');
      }
    } catch (error) {
      if (!(error instanceof RailwayReadError)) throw error;
      consecutiveReadErrors += 1;
      if (consecutiveReadErrors >= maxConsecutiveReadErrors) throw error;
    }

    await sleepImpl(pollIntervalMs);
  }

  throw new Error('Railway rollback deployment did not reach SUCCESS in time');
}

function appendRollbackOutput(outputPath, deploymentId, appendFile = appendFileSync) {
  if (!outputPath) return;
  appendFile(outputPath, `rollback_deployment_id=${requireSafeId(deploymentId, 'rollback deployment ID')}\n`, 'utf8');
}

async function runCli() {
  const rawServiceLabel = String(process.env.SERVICE_LABEL ?? 'service').trim();
  const serviceLabel = /^[A-Za-z0-9._ -]{1,40}$/.test(rawServiceLabel) ? rawServiceLabel : 'service';
  const result = await rollbackDeployment({
    expectedCurrentDeploymentId: process.env.EXPECTED_CURRENT_DEPLOYMENT_ID,
    serviceId: process.env.RAILWAY_SERVICE_ID,
    targetDeploymentId: process.env.TARGET_DEPLOYMENT_ID,
    token: process.env.RAILWAY_TOKEN,
  });

  appendRollbackOutput(process.env.GITHUB_OUTPUT, result.deploymentId);
  console.log(`Verified Railway rollback for ${serviceLabel}: ${result.deploymentId}`);
}

if (process.argv[1] === scriptPath) {
  try {
    await runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.error(`railway-deployment-rollback: ${message}`);
    process.exit(1);
  }
}

export {
  ACTIVE_STATUSES,
  DEPLOYMENTS_QUERY,
  DEPLOYMENT_QUERY,
  FAILED_STATUSES,
  PROJECT_TOKEN_QUERY,
  RAILWAY_GRAPHQL_ENDPOINT,
  ROLLBACK_MUTATION,
  SERVICE_INSTANCE_STATE_QUERY,
  RailwayReadError,
  appendRollbackOutput,
  deploymentsAfterBaseline,
  requestGraphql,
  rollbackDeployment,
};
