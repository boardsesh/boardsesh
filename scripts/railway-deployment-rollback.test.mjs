import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROLLBACK_MUTATION, appendRollbackOutput, rollbackDeployment } from './railway-deployment-rollback.mjs';

const SERVICE_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_SERVICE_ID = '10000000-0000-4000-8000-000000000002';
const PROJECT_ID = '30000000-0000-4000-8000-000000000001';
const OTHER_PROJECT_ID = '30000000-0000-4000-8000-000000000002';
const ENVIRONMENT_ID = '40000000-0000-4000-8000-000000000001';
const OTHER_ENVIRONMENT_ID = '40000000-0000-4000-8000-000000000002';
const TARGET_ID = '20000000-0000-4000-8000-000000000001';
const CURRENT_ID = '20000000-0000-4000-8000-000000000002';
const ROLLBACK_ID = '20000000-0000-4000-8000-000000000003';
const CONCURRENT_ID = '20000000-0000-4000-8000-000000000004';
const OLDER_ID = '20000000-0000-4000-8000-000000000005';
const IMAGE = 'ghcr.io/boardsesh/boardsesh-web:production';
const TOKEN = 'railway-project-token-secret';
const TARGET_CREATED_AT = '2026-09-01T00:00:00.000Z';
const CURRENT_CREATED_AT = '2026-09-01T00:10:00.000Z';
const ROLLBACK_CREATED_AT = '2026-09-01T00:20:00.000Z';
const CONCURRENT_CREATED_AT = '2026-09-01T00:21:00.000Z';

function deployment(
  id,
  status,
  {
    canRollback = true,
    createdAt = CURRENT_CREATED_AT,
    environmentId = ENVIRONMENT_ID,
    image = IMAGE,
    projectId = PROJECT_ID,
    serviceId = SERVICE_ID,
  } = {},
) {
  return {
    id,
    status,
    serviceId,
    environmentId,
    projectId,
    createdAt,
    canRollback,
    meta: image ? { image } : {},
  };
}

function targetDeployment(overrides = {}) {
  const { createdAt = TARGET_CREATED_AT, id = TARGET_ID, status = 'SUCCESS', ...deploymentOverrides } = overrides;
  return deployment(id, status, { createdAt, ...deploymentOverrides });
}

function currentDeployment(overrides = {}) {
  const { createdAt = CURRENT_CREATED_AT, id = CURRENT_ID, status = 'FAILED', ...deploymentOverrides } = overrides;
  return deployment(id, status, { createdAt, ...deploymentOverrides });
}

function rollbackResultDeployment(status = 'QUEUED', overrides = {}) {
  const { createdAt = ROLLBACK_CREATED_AT, id = ROLLBACK_ID, ...deploymentOverrides } = overrides;
  return deployment(id, status, { createdAt, ...deploymentOverrides });
}

function concurrentDeployment(overrides = {}) {
  const {
    createdAt = CONCURRENT_CREATED_AT,
    id = CONCURRENT_ID,
    status = 'DEPLOYING',
    ...deploymentOverrides
  } = overrides;
  return deployment(id, status, { createdAt, ...deploymentOverrides });
}

function baselineDeployments(overrides = {}) {
  return [
    currentDeployment(overrides.current),
    targetDeployment(overrides.target),
    deployment(OLDER_ID, 'CRASHED', { createdAt: '2026-08-31T23:00:00.000Z', ...overrides.older }),
  ];
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function projectScopeResponse(overrides = {}) {
  return jsonResponse({
    data: {
      projectToken: {
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        ...overrides,
      },
    },
  });
}

function deploymentResponse(rawDeployment) {
  return jsonResponse({ data: { deployment: rawDeployment } });
}

function deploymentListResponse(deployments) {
  return jsonResponse({
    data: {
      deployments: {
        edges: deployments.map((node) => ({ node })),
      },
    },
  });
}

function mutationResponse(value = true) {
  return jsonResponse({ data: { deploymentRollback: value } });
}

function serviceInstanceStateResponse(latestDeployment, activeDeployments = [latestDeployment]) {
  return jsonResponse({
    data: {
      serviceInstance: {
        activeDeployments,
        latestDeployment,
      },
    },
  });
}

function sequenceFetch(responses, calls = []) {
  const pending = [...responses];
  return async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const next = pending.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('unexpected fetch');
    return next;
  };
}

function baseOptions(fetchImpl, overrides = {}) {
  return {
    expectedCurrentDeploymentId: CURRENT_ID,
    fetchImpl,
    serviceId: SERVICE_ID,
    sleepImpl: async () => {},
    targetDeploymentId: TARGET_ID,
    token: TOKEN,
    ...overrides,
  };
}

function preflightResponses({ scope = projectScopeResponse(), target, current, baseline } = {}) {
  return [
    scope,
    deploymentResponse(target ?? targetDeployment()),
    deploymentResponse(current ?? currentDeployment()),
    deploymentListResponse(baseline ?? baselineDeployments()),
  ];
}

function mutationCalls(calls) {
  return calls.filter(({ body }) => body.query.includes('mutation VerifiedDeploymentRollback'));
}

function uuidStringValues(value) {
  if (typeof value === 'string') return /^[0-9a-f-]{36}$/i.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(uuidStringValues);
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(uuidStringValues);
}

void test('uses Railway Boolean! rollback once, locks its new ID, and verifies exact ID plus scoped list', async () => {
  const calls = [];
  const queuedRollback = rollbackResultDeployment('QUEUED');
  const successfulRollback = rollbackResultDeployment('SUCCESS');
  const result = await rollbackDeployment(
    baseOptions(
      sequenceFetch(
        [
          ...preflightResponses(),
          mutationResponse(true),
          deploymentListResponse([...baselineDeployments(), queuedRollback]),
          deploymentResponse(queuedRollback),
          deploymentListResponse([...baselineDeployments(), queuedRollback]),
          deploymentResponse(successfulRollback),
          deploymentListResponse([...baselineDeployments(), successfulRollback]),
          serviceInstanceStateResponse(successfulRollback),
        ],
        calls,
      ),
    ),
  );

  assert.deepEqual(result, { deploymentId: ROLLBACK_ID, image: IMAGE });
  assert.equal(mutationCalls(calls).length, 1);
  assert.match(ROLLBACK_MUTATION, /deploymentRollback\(id: \$id\)\s*\n\s*}/);
  assert.doesNotMatch(ROLLBACK_MUTATION, /deploymentRollback\([^)]*\)\s*{/);
  assert.deepEqual(mutationCalls(calls)[0].body.variables, { id: TARGET_ID });

  const exactDeploymentVariables = calls
    .filter(({ body }) => body.query.includes('query DeploymentForVerifiedRollback'))
    .map(({ body }) => body.variables);
  assert.deepEqual(exactDeploymentVariables, [
    { id: TARGET_ID },
    { id: CURRENT_ID },
    { id: ROLLBACK_ID },
    { id: ROLLBACK_ID },
  ]);

  const listCalls = calls.filter(({ body }) => body.query.includes('query ServiceDeploymentsForVerifiedRollback'));
  assert.equal(listCalls.length, 4);
  for (const { body } of listCalls) {
    assert.deepEqual(body.variables, {
      input: {
        environmentId: ENVIRONMENT_ID,
        includeDeleted: true,
        projectId: PROJECT_ID,
        serviceId: SERVICE_ID,
      },
      first: 100,
    });
  }
  const serviceStateCalls = calls.filter(({ body }) =>
    body.query.includes('query ServiceInstanceStateForVerifiedRollback'),
  );
  assert.equal(serviceStateCalls.length, 1);
  assert.deepEqual(serviceStateCalls[0].body.variables, {
    environmentId: ENVIRONMENT_ID,
    serviceId: SERVICE_ID,
  });

  for (const { options } of calls) {
    assert.equal(options.headers['Project-Access-Token'], TOKEN);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.body.includes(TOKEN), false);
    assert.equal(options.signal instanceof AbortSignal, true);
  }
});

void test('requires an expected-current ID, rejects target equality, and writes only a normalized safe output', async () => {
  for (const expectedCurrentDeploymentId of [undefined, '', 'unsafe', TARGET_ID]) {
    let fetchCalls = 0;
    await assert.rejects(
      rollbackDeployment(
        baseOptions(
          async () => {
            fetchCalls += 1;
            throw new Error('fetch should not run');
          },
          { expectedCurrentDeploymentId },
        ),
      ),
    );
    assert.equal(fetchCalls, 0);
  }

  const appendCalls = [];
  appendRollbackOutput('/safe/output', ROLLBACK_ID.toUpperCase(), (...arguments_) => appendCalls.push(arguments_));
  assert.deepEqual(appendCalls, [['/safe/output', `rollback_deployment_id=${ROLLBACK_ID}\n`, 'utf8']]);
  appendRollbackOutput('/safe/output', '20000000-0000-0000-7000-000000000003', (...arguments_) =>
    appendCalls.push(arguments_),
  );
  assert.deepEqual(appendCalls.at(-1), [
    '/safe/output',
    'rollback_deployment_id=20000000-0000-0000-7000-000000000003\n',
    'utf8',
  ]);
  assert.throws(() => appendRollbackOutput('/safe/output', `${ROLLBACK_ID}\nINJECTED=1`, () => {}), /Railway UUID/);
});

void test('derives project/environment from projectToken and lowercases every UUID used in API calls', async () => {
  const calls = [];
  const uppercase = (rawDeployment) => ({
    ...rawDeployment,
    id: rawDeployment.id.toUpperCase(),
    serviceId: rawDeployment.serviceId.toUpperCase(),
    environmentId: rawDeployment.environmentId.toUpperCase(),
    projectId: rawDeployment.projectId.toUpperCase(),
  });
  const upperBaseline = baselineDeployments().map(uppercase);
  const upperRollback = uppercase(rollbackResultDeployment('SUCCESS'));

  const result = await rollbackDeployment({
    ...baseOptions(
      sequenceFetch(
        [
          projectScopeResponse({
            projectId: PROJECT_ID.toUpperCase(),
            environmentId: ENVIRONMENT_ID.toUpperCase(),
          }),
          deploymentResponse(uppercase(targetDeployment())),
          deploymentResponse(uppercase(currentDeployment())),
          deploymentListResponse(upperBaseline),
          mutationResponse(true),
          deploymentListResponse([...upperBaseline, upperRollback]),
          deploymentResponse(upperRollback),
          deploymentListResponse([...upperBaseline, upperRollback]),
          serviceInstanceStateResponse(upperRollback),
        ],
        calls,
      ),
    ),
    expectedCurrentDeploymentId: CURRENT_ID.toUpperCase(),
    serviceId: SERVICE_ID.toUpperCase(),
    targetDeploymentId: TARGET_ID.toUpperCase(),
  });

  assert.equal(result.deploymentId, ROLLBACK_ID);
  for (const { body } of calls) {
    for (const uuid of uuidStringValues(body.variables)) assert.equal(uuid, uuid.toLowerCase());
  }
});

void test('refuses invalid token scope before querying deployments or mutating', async () => {
  for (const scopeResponse of [
    projectScopeResponse({ projectId: 'unsafe' }),
    projectScopeResponse({ environmentId: 'unsafe' }),
    jsonResponse({ data: { projectToken: null } }),
  ]) {
    const calls = [];
    await assert.rejects(
      rollbackDeployment(
        baseOptions(sequenceFetch([scopeResponse], calls), {
          maxConsecutiveReadErrors: 1,
        }),
      ),
    );
    assert.equal(calls.length, 1);
    assert.equal(mutationCalls(calls).length, 0);
  }
});

void test('refuses target identity, scope, status, rollback capability, image, and timestamp defects before mutation', async () => {
  const badTargets = [
    targetDeployment({ id: CURRENT_ID }),
    targetDeployment({ serviceId: OTHER_SERVICE_ID }),
    targetDeployment({ environmentId: OTHER_ENVIRONMENT_ID }),
    targetDeployment({ projectId: OTHER_PROJECT_ID }),
    targetDeployment({ status: 'FAILED' }),
    targetDeployment({ status: 'FUTURE_STATUS' }),
    targetDeployment({ canRollback: false }),
    { ...targetDeployment(), canRollback: undefined },
    targetDeployment({ image: null }),
    targetDeployment({ createdAt: 'not-a-date' }),
  ];

  for (const badTarget of badTargets) {
    const calls = [];
    await assert.rejects(
      rollbackDeployment(baseOptions(sequenceFetch([...preflightResponses({ target: badTarget })], calls))),
      (error) => !String(error.message).includes('request failed'),
    );
    assert.equal(mutationCalls(calls).length, 0);
  }

  const removedTarget = targetDeployment({ status: 'REMOVED', canRollback: true });
  const successfulRollback = rollbackResultDeployment('SUCCESS');
  const result = await rollbackDeployment(
    baseOptions(
      sequenceFetch([
        ...preflightResponses({ target: removedTarget }),
        mutationResponse(true),
        deploymentListResponse([...baselineDeployments({ target: { status: 'REMOVED' } }), successfulRollback]),
        deploymentResponse(successfulRollback),
        deploymentListResponse([...baselineDeployments({ target: { status: 'REMOVED' } }), successfulRollback]),
        serviceInstanceStateResponse(successfulRollback),
      ]),
    ),
  );
  assert.equal(result.deploymentId, ROLLBACK_ID);
});

void test('refuses expected-current identity/scope/time/status defects before mutation', async () => {
  const badCurrents = [
    currentDeployment({ id: ROLLBACK_ID }),
    currentDeployment({ serviceId: OTHER_SERVICE_ID }),
    currentDeployment({ environmentId: OTHER_ENVIRONMENT_ID }),
    currentDeployment({ projectId: OTHER_PROJECT_ID }),
    currentDeployment({ createdAt: TARGET_CREATED_AT }),
    currentDeployment({ createdAt: 'not-a-date' }),
    currentDeployment({ status: 'FUTURE_STATUS' }),
    currentDeployment({ status: 'CANCELED' }),
    currentDeployment({ status: 'CANCELLED' }),
  ];

  for (const badCurrent of badCurrents) {
    const calls = [];
    await assert.rejects(
      rollbackDeployment(baseOptions(sequenceFetch([...preflightResponses({ current: badCurrent })], calls))),
      (error) => !String(error.message).includes('request failed'),
    );
    assert.equal(mutationCalls(calls).length, 0);
  }
});

void test('requires expected-current to be the sole newest deployment in the fresh scoped baseline', async () => {
  const tiedConcurrent = concurrentDeployment({ createdAt: CURRENT_CREATED_AT });
  const cases = [
    baselineDeployments().filter(({ id }) => id !== CURRENT_ID),
    [...baselineDeployments(), concurrentDeployment()],
    [...baselineDeployments(), tiedConcurrent],
    baselineDeployments().map((item) =>
      item.id === CURRENT_ID ? { ...item, createdAt: '2026-09-01T00:09:59.000Z' } : item,
    ),
    baselineDeployments().map((item) => (item.id === CURRENT_ID ? { ...item, status: 'CANCELLED' } : item)),
    [...baselineDeployments(), { ...targetDeployment(), id: CURRENT_ID }],
    baselineDeployments().map((item) => (item.id === TARGET_ID ? { ...item, serviceId: OTHER_SERVICE_ID } : item)),
    [...baselineDeployments(), concurrentDeployment({ createdAt: '2026-08-31T22:00:00.000Z', status: 'BUILDING' })],
    [...baselineDeployments(), concurrentDeployment({ createdAt: '2026-09-01T00:05:00.000Z', status: 'SUCCESS' })],
  ];

  for (const baseline of cases) {
    const calls = [];
    await assert.rejects(rollbackDeployment(baseOptions(sequenceFetch([...preflightResponses({ baseline })], calls))));
    assert.equal(mutationCalls(calls).length, 0);
  }
});

void test('allows fenced recovery from a wrong-image current deployment and pre-existing terminal failures', async () => {
  const wrongImage = 'ghcr.io/boardsesh/unexpected:production';
  const preExistingFailure = concurrentDeployment({
    createdAt: '2026-09-01T00:05:00.000Z',
    image: wrongImage,
    status: 'FAILED',
  });
  const baseline = [
    currentDeployment({ image: wrongImage }),
    preExistingFailure,
    targetDeployment(),
    deployment(OLDER_ID, 'CRASHED', { createdAt: '2026-08-31T23:00:00.000Z' }),
  ];
  const successfulRollback = rollbackResultDeployment('SUCCESS');
  const result = await rollbackDeployment(
    baseOptions(
      sequenceFetch([
        ...preflightResponses({ current: currentDeployment({ image: wrongImage }), baseline }),
        mutationResponse(true),
        deploymentListResponse([...baseline, successfulRollback]),
        deploymentResponse(successfulRollback),
        deploymentListResponse([...baseline, successfulRollback]),
        serviceInstanceStateResponse(successfulRollback),
      ]),
    ),
  );

  assert.equal(result.deploymentId, ROLLBACK_ID);
});

void test('requires the live scalar result to be exactly true', async () => {
  for (const mutation of [
    mutationResponse(false),
    jsonResponse({ data: {} }),
    jsonResponse({ data: { deploymentRollback: { id: ROLLBACK_ID } } }),
    jsonResponse({ data: { deploymentRollback: 'true' } }),
  ]) {
    const calls = [];
    await assert.rejects(
      rollbackDeployment(baseOptions(sequenceFetch([...preflightResponses(), mutation], calls))),
      /rollback mutation/,
    );
    assert.equal(mutationCalls(calls).length, 1);
  }
});

void test('never retries an ambiguous mutation response and never exposes token-bearing bodies', async () => {
  const ambiguousMutations = [
    new Error(TOKEN),
    jsonResponse({ error: TOKEN }, 503),
    { ok: true, status: 200, json: async () => Promise.reject(new Error(TOKEN)) },
    jsonResponse({ errors: [{ message: TOKEN }], data: null }),
    jsonResponse({ data: null }),
  ];

  for (const ambiguousMutation of ambiguousMutations) {
    const calls = [];
    await assert.rejects(
      rollbackDeployment(baseOptions(sequenceFetch([...preflightResponses(), ambiguousMutation], calls))),
      (error) => !String(error.message).includes(TOKEN),
    );
    assert.equal(mutationCalls(calls).length, 1);
    assert.equal(calls.length, 5);
  }
});

void test('waits for one post-baseline ID, then locks and verifies it', async () => {
  const successfulRollback = rollbackResultDeployment('SUCCESS');
  const result = await rollbackDeployment(
    baseOptions(
      sequenceFetch([
        ...preflightResponses(),
        mutationResponse(true),
        deploymentListResponse(baselineDeployments()),
        deploymentListResponse([...baselineDeployments(), successfulRollback]),
        deploymentResponse(successfulRollback),
        deploymentListResponse([...baselineDeployments(), successfulRollback]),
        serviceInstanceStateResponse(successfulRollback),
      ]),
    ),
  );
  assert.equal(result.deploymentId, ROLLBACK_ID);
});

void test('waits until the rollback is the sole active deployment and rejects a wrong latest ID', async () => {
  const successfulRollback = rollbackResultDeployment('SUCCESS');
  const stillActiveTarget = targetDeployment();
  const result = await rollbackDeployment(
    baseOptions(
      sequenceFetch([
        ...preflightResponses(),
        mutationResponse(true),
        deploymentListResponse([...baselineDeployments(), successfulRollback]),
        deploymentResponse(successfulRollback),
        deploymentListResponse([...baselineDeployments(), successfulRollback]),
        serviceInstanceStateResponse(successfulRollback, [stillActiveTarget, successfulRollback]),
        deploymentResponse(successfulRollback),
        deploymentListResponse([...baselineDeployments(), successfulRollback]),
        serviceInstanceStateResponse(successfulRollback),
      ]),
    ),
  );
  assert.equal(result.deploymentId, ROLLBACK_ID);

  await assert.rejects(
    rollbackDeployment(
      baseOptions(
        sequenceFetch([
          ...preflightResponses(),
          mutationResponse(true),
          deploymentListResponse([...baselineDeployments(), successfulRollback]),
          deploymentResponse(successfulRollback),
          deploymentListResponse([...baselineDeployments(), successfulRollback]),
          serviceInstanceStateResponse(currentDeployment(), [successfulRollback]),
        ]),
      ),
    ),
    /not the service instance latest deployment/,
  );

  const crashedRollback = rollbackResultDeployment('CRASHED');
  await assert.rejects(
    rollbackDeployment(
      baseOptions(
        sequenceFetch([
          ...preflightResponses(),
          mutationResponse(true),
          deploymentListResponse([...baselineDeployments(), successfulRollback]),
          deploymentResponse(successfulRollback),
          deploymentListResponse([...baselineDeployments(), successfulRollback]),
          serviceInstanceStateResponse(crashedRollback, [crashedRollback]),
        ]),
      ),
    ),
    /latest deployment reached terminal status CRASHED/,
  );
});

void test('rejects concurrent deployments both before locking and after locking', async () => {
  const queuedRollback = rollbackResultDeployment('QUEUED');
  const beforeLockCalls = [];
  await assert.rejects(
    rollbackDeployment(
      baseOptions(
        sequenceFetch(
          [
            ...preflightResponses(),
            mutationResponse(true),
            deploymentListResponse([...baselineDeployments(), queuedRollback, concurrentDeployment()]),
          ],
          beforeLockCalls,
        ),
      ),
    ),
    /concurrent post-baseline/,
  );
  assert.equal(mutationCalls(beforeLockCalls).length, 1);

  const afterLockCalls = [];
  await assert.rejects(
    rollbackDeployment(
      baseOptions(
        sequenceFetch(
          [
            ...preflightResponses(),
            mutationResponse(true),
            deploymentListResponse([...baselineDeployments(), queuedRollback]),
            deploymentResponse(queuedRollback),
            deploymentListResponse([...baselineDeployments(), queuedRollback, concurrentDeployment()]),
          ],
          afterLockCalls,
        ),
      ),
    ),
    /concurrent post-baseline/,
  );
  assert.equal(mutationCalls(afterLockCalls).length, 1);
});

void test('rejects locked rollback identity, scope, image, timestamp, and status defects', async () => {
  const badPollCases = [
    {
      exact: rollbackResultDeployment('SUCCESS', { id: CONCURRENT_ID }),
      listed: rollbackResultDeployment('SUCCESS'),
    },
    {
      exact: rollbackResultDeployment('SUCCESS', { serviceId: OTHER_SERVICE_ID }),
      listed: rollbackResultDeployment('SUCCESS'),
    },
    {
      exact: rollbackResultDeployment('SUCCESS', { environmentId: OTHER_ENVIRONMENT_ID }),
      listed: rollbackResultDeployment('SUCCESS'),
    },
    {
      exact: rollbackResultDeployment('SUCCESS', { projectId: OTHER_PROJECT_ID }),
      listed: rollbackResultDeployment('SUCCESS'),
    },
    {
      exact: rollbackResultDeployment('SUCCESS', { image: 'wrong:image' }),
      listed: rollbackResultDeployment('SUCCESS'),
    },
    {
      exact: rollbackResultDeployment('SUCCESS', { createdAt: '2026-09-01T00:20:01.000Z' }),
      listed: rollbackResultDeployment('SUCCESS'),
    },
    {
      exact: rollbackResultDeployment('CRASHED'),
      listed: rollbackResultDeployment('CRASHED'),
    },
    {
      exact: rollbackResultDeployment('FUTURE_STATUS'),
      listed: rollbackResultDeployment('FUTURE_STATUS'),
    },
  ];

  for (const { exact, listed } of badPollCases) {
    const calls = [];
    await assert.rejects(
      rollbackDeployment(
        baseOptions(
          sequenceFetch(
            [
              ...preflightResponses(),
              mutationResponse(true),
              deploymentListResponse([...baselineDeployments(), rollbackResultDeployment('QUEUED')]),
              deploymentResponse(exact),
              deploymentListResponse([...baselineDeployments(), listed]),
            ],
            calls,
          ),
        ),
      ),
      (error) => !String(error.message).includes('request failed'),
    );
    assert.equal(mutationCalls(calls).length, 1);
  }

  const wrongListedImage = rollbackResultDeployment('SUCCESS', { image: 'wrong:image' });
  await assert.rejects(
    rollbackDeployment(
      baseOptions(
        sequenceFetch([
          ...preflightResponses(),
          mutationResponse(true),
          deploymentListResponse([...baselineDeployments(), rollbackResultDeployment('SUCCESS')]),
          deploymentResponse(rollbackResultDeployment('SUCCESS')),
          deploymentListResponse([...baselineDeployments(), wrongListedImage]),
        ]),
      ),
    ),
    /listed rollback deployment image/,
  );
});

void test('retries only bounded read failures and never repeats an accepted mutation', async () => {
  const calls = [];
  const successfulRollback = rollbackResultDeployment('SUCCESS');
  const result = await rollbackDeployment(
    baseOptions(
      sequenceFetch(
        [
          new Error('scope read failed'),
          projectScopeResponse(),
          deploymentResponse(targetDeployment()),
          deploymentResponse(currentDeployment()),
          deploymentListResponse(baselineDeployments()),
          mutationResponse(true),
          new Error('discovery read failed'),
          deploymentListResponse([...baselineDeployments(), successfulRollback]),
          new Error('exact poll failed'),
          deploymentResponse(successfulRollback),
          deploymentListResponse([...baselineDeployments(), successfulRollback]),
          serviceInstanceStateResponse(successfulRollback),
        ],
        calls,
      ),
    ),
  );
  assert.equal(result.deploymentId, ROLLBACK_ID);
  assert.equal(mutationCalls(calls).length, 1);

  const failedCalls = [];
  await assert.rejects(
    rollbackDeployment(
      baseOptions(
        sequenceFetch(
          [...preflightResponses(), mutationResponse(true), new Error('one'), new Error('two'), new Error('three')],
          failedCalls,
        ),
      ),
    ),
    /rollback discovery list request failed/,
  );
  assert.equal(mutationCalls(failedCalls).length, 1);

  const serviceStateFailureCalls = [];
  await assert.rejects(
    rollbackDeployment(
      baseOptions(
        sequenceFetch(
          [
            ...preflightResponses(),
            mutationResponse(true),
            deploymentListResponse([...baselineDeployments(), successfulRollback]),
            deploymentResponse(successfulRollback),
            deploymentListResponse([...baselineDeployments(), successfulRollback]),
            new Error('first service-state read failed'),
            deploymentResponse(successfulRollback),
            deploymentListResponse([...baselineDeployments(), successfulRollback]),
            new Error('second service-state read failed'),
          ],
          serviceStateFailureCalls,
        ),
        { maxConsecutiveReadErrors: 2 },
      ),
    ),
    /rollback service instance verification request failed/,
  );
  assert.equal(mutationCalls(serviceStateFailureCalls).length, 1);
});

void test('bounds preflight reads and poll attempts without mutation retries', async () => {
  const preflightCalls = [];
  await assert.rejects(
    rollbackDeployment(
      baseOptions(sequenceFetch([new Error('one'), new Error('two')], preflightCalls), {
        maxConsecutiveReadErrors: 2,
      }),
    ),
    /project token query request failed/,
  );
  assert.equal(mutationCalls(preflightCalls).length, 0);

  const timeoutCalls = [];
  await assert.rejects(
    rollbackDeployment(
      baseOptions(
        sequenceFetch(
          [
            ...preflightResponses(),
            mutationResponse(true),
            deploymentListResponse(baselineDeployments()),
            deploymentListResponse(baselineDeployments()),
          ],
          timeoutCalls,
        ),
        { maxPollAttempts: 2 },
      ),
    ),
    /did not reach SUCCESS in time/,
  );
  assert.equal(mutationCalls(timeoutCalls).length, 1);
});
