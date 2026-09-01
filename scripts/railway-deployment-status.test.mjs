import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { capturePreviousDeployment, findNewDeployment } from './railway-deployment-status.mjs';

const EXPECTED_IMAGE = 'ghcr.io/boardsesh/boardsesh-web:production';
const STATUS_SCRIPT_PATH = fileURLToPath(new URL('./railway-deployment-status.mjs', import.meta.url));
const IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
];

function deployment(id, status, createdAt, image = EXPECTED_IMAGE) {
  return { id, status, createdAt, meta: image === undefined ? {} : { image } };
}

void test('captures the latest SUCCESS rather than the first list entry and pins its image', () => {
  const previous = capturePreviousDeployment(
    {
      deployments: [
        deployment(IDS[2], 'FAILED', '2026-05-31T10:02:00.000Z'),
        deployment(IDS[1], 'SUCCESS', '2026-05-31T10:01:00.000Z'),
        deployment(IDS[0], 'SUCCESS', '2026-05-31T10:00:00.000Z'),
      ],
    },
    EXPECTED_IMAGE,
  );

  assert.equal(previous.id, IDS[1]);
  assert.equal(previous.image, EXPECTED_IMAGE);
  assert.deepEqual(previous.baselineIds, [IDS[2], IDS[1], IDS[0]]);
});

void test('fails closed on an unusable previous deployment', () => {
  assert.throws(
    () => capturePreviousDeployment({ deployments: [] }, EXPECTED_IMAGE),
    /previous successful Railway deployment/,
  );
  assert.throws(
    () =>
      capturePreviousDeployment(
        { deployments: [deployment(IDS[0], 'SUCCESS', '2026-05-31T10:00:00.000Z', null)] },
        EXPECTED_IMAGE,
      ),
    /meta\.image/,
  );
  assert.throws(
    () =>
      capturePreviousDeployment(
        { deployments: [deployment(IDS[0], 'SUCCESS', '2026-05-31T10:00:00.000Z', 'wrong:image')] },
        EXPECTED_IMAGE,
      ),
    /did not match EXPECTED_IMAGE/,
  );
  assert.throws(
    () =>
      capturePreviousDeployment(
        {
          deployments: [
            deployment(IDS[0], 'SUCCESS', '2026-05-31T10:00:00.000Z'),
            deployment(IDS[1], 'SUCCESS', '2026-05-31T10:00:00.000Z'),
          ],
        },
        EXPECTED_IMAGE,
      ),
    /timestamps are tied/,
  );
});

void test('captures only a quiet service and refuses active or unknown baseline rows', () => {
  const quietBaseline = [
    deployment(IDS[2], 'FAILED', '2026-05-31T10:02:00.000Z'),
    deployment(IDS[1], 'SUCCESS', '2026-05-31T10:01:00.000Z'),
    deployment(IDS[0], 'REMOVING', '2026-05-31T10:00:00.000Z'),
  ];
  assert.equal(capturePreviousDeployment({ deployments: quietBaseline }, EXPECTED_IMAGE).id, IDS[1]);

  for (const activeStatus of ['BUILDING', 'DEPLOYING', 'INITIALIZING', 'NEEDS_APPROVAL', 'QUEUED', 'WAITING']) {
    assert.throws(
      () =>
        capturePreviousDeployment(
          {
            deployments: [
              deployment(IDS[2], activeStatus, '2026-05-31T09:59:00.000Z'),
              deployment(IDS[1], 'SUCCESS', '2026-05-31T10:01:00.000Z'),
            ],
          },
          EXPECTED_IMAGE,
        ),
      /service is not quiet/,
    );
  }

  assert.throws(
    () =>
      capturePreviousDeployment(
        {
          deployments: [
            deployment(IDS[2], 'FUTURE_STATUS', '2026-05-31T10:02:00.000Z'),
            deployment(IDS[1], 'SUCCESS', '2026-05-31T10:01:00.000Z'),
          ],
        },
        EXPECTED_IMAGE,
      ),
    /unknown status FUTURE_STATUS/,
  );

  assert.throws(
    () =>
      capturePreviousDeployment(
        {
          deployments: [
            deployment(IDS[2], 'SLEEPING', '2026-05-31T10:02:00.000Z'),
            deployment(IDS[1], 'SUCCESS', '2026-05-31T10:01:00.000Z'),
          ],
        },
        EXPECTED_IMAGE,
      ),
    /does not support services with application sleeping enabled/,
  );
});

void test('rejects malformed deployment lists and ambiguous image inputs', () => {
  assert.throws(
    () =>
      capturePreviousDeployment(
        { deployments: [deployment('unsafe', 'SUCCESS', '2026-05-31T10:00:00.000Z')] },
        EXPECTED_IMAGE,
      ),
    /unsafe deployment ID/,
  );
  assert.throws(
    () =>
      capturePreviousDeployment(
        {
          deployments: [
            deployment(IDS[0], 'SUCCESS', '2026-05-31T10:00:00.000Z'),
            deployment(IDS[0], 'FAILED', '2026-05-31T10:01:00.000Z'),
          ],
        },
        EXPECTED_IMAGE,
      ),
    /duplicate deployment ID/,
  );
  assert.throws(
    () => capturePreviousDeployment({ deployments: [deployment(IDS[0], 'SUCCESS', 'not-a-date')] }, EXPECTED_IMAGE),
    /invalid createdAt/,
  );
  assert.throws(
    () =>
      capturePreviousDeployment(
        { deployments: [deployment(IDS[0], 'SUCCESS', '2026-05-31T10:00:00.000Z')] },
        ` ${EXPECTED_IMAGE}`,
      ),
    /without whitespace/,
  );
});

void test('discovers exactly one post-trigger deployment with the expected image', () => {
  const options = {
    baselineIds: IDS.slice(0, 2).join(','),
    expectedImage: EXPECTED_IMAGE,
    captureStartedAt: '2026-05-31T10:00:30.000Z',
  };
  const baseline = [
    deployment(IDS[1], 'SUCCESS', '2026-05-31T10:00:00.000Z'),
    deployment(IDS[0], 'SUCCESS', '2026-05-31T09:00:00.000Z'),
  ];

  assert.equal(findNewDeployment({ deployments: baseline }, options).id, '');
  assert.equal(
    findNewDeployment(
      { deployments: [deployment(IDS[2], 'BUILDING', '2026-05-31T10:01:00.000Z'), ...baseline] },
      options,
    ).id,
    IDS[2],
  );
  assert.throws(
    () =>
      findNewDeployment(
        {
          deployments: [
            deployment(IDS[3], 'QUEUED', '2026-05-31T10:02:00.000Z'),
            deployment(IDS[2], 'BUILDING', '2026-05-31T10:01:00.000Z'),
            ...baseline,
          ],
        },
        options,
      ),
    /multiple new deployments/,
  );
  assert.throws(
    () =>
      findNewDeployment(
        { deployments: [deployment(IDS[2], 'BUILDING', '2026-05-31T10:01:00.000Z', 'wrong:image'), ...baseline] },
        options,
      ),
    /did not match EXPECTED_IMAGE/,
  );
  assert.throws(
    () =>
      findNewDeployment(
        { deployments: [deployment(IDS[2], 'BUILDING', '2026-05-31T09:54:00.000Z'), ...baseline] },
        options,
      ),
    /predates the baseline capture/,
  );
});

void test('CLI reports the exact candidate ID before failing wrong-image validation', () => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'railway-status-wrong-image-'));
  const fixturePath = join(fixtureDirectory, 'deployments.json');
  try {
    writeFileSync(
      fixturePath,
      JSON.stringify({
        deployments: [
          deployment(IDS[2], 'BUILDING', '2026-05-31T10:01:00.000Z', 'ghcr.io/boardsesh/unexpected:latest'),
        ],
      }),
    );
    const cliResult = spawnSync(process.execPath, [STATUS_SCRIPT_PATH, 'find-new', fixturePath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BASELINE_DEPLOYMENT_IDS: IDS.slice(0, 2).join(','),
        EXPECTED_IMAGE,
        LOCKED_DEPLOYMENT_ID: '',
        CAPTURE_STARTED_AT: '2026-05-31T10:00:30.000Z',
      },
    });

    assert.notEqual(cliResult.status, 0);
    assert.match(cliResult.stdout, new RegExp(`CURRENT_ID='${IDS[2]}'`));
    assert.match(cliResult.stderr, /image did not match EXPECTED_IMAGE/);
  } finally {
    rmSync(fixtureDirectory, { recursive: true });
  }
});

void test('keeps polling one locked deployment only while no concurrent deployment appears', () => {
  const locked = findNewDeployment(
    {
      deployments: [deployment(IDS[2], 'DEPLOYING', '2026-05-31T10:01:00.000Z')],
    },
    { baselineIds: IDS.slice(0, 2).join(','), expectedImage: EXPECTED_IMAGE, lockedId: IDS[2] },
  );
  assert.equal(locked.id, IDS[2]);
  assert.equal(locked.status, 'DEPLOYING');

  assert.throws(
    () =>
      findNewDeployment(
        { deployments: [deployment(IDS[3], 'BUILDING', '2026-05-31T10:02:00.000Z')] },
        { baselineIds: IDS.slice(0, 2).join(','), expectedImage: EXPECTED_IMAGE, lockedId: IDS[2] },
      ),
    /disappeared/,
  );

  assert.throws(
    () =>
      findNewDeployment(
        {
          deployments: [
            deployment(IDS[3], 'BUILDING', '2026-05-31T10:02:00.000Z'),
            deployment(IDS[2], 'DEPLOYING', '2026-05-31T10:01:00.000Z'),
          ],
        },
        { baselineIds: IDS.slice(0, 2).join(','), expectedImage: EXPECTED_IMAGE, lockedId: IDS[2] },
      ),
    /concurrent Railway deployment/,
  );
});

void test('normalizes Railway CLI Other("CANCELLED") as a quiet terminal status', () => {
  const previous = capturePreviousDeployment(
    {
      deployments: [
        deployment(IDS[2], 'Other("CANCELLED")', '2026-05-31T10:02:00.000Z'),
        deployment(IDS[1], 'SUCCESS', '2026-05-31T10:01:00.000Z'),
      ],
    },
    EXPECTED_IMAGE,
  );

  assert.equal(previous.id, IDS[1]);
  assert.deepEqual(previous.baselineIds, [IDS[2], IDS[1]]);
});

void test('quarantines a sole wrapped cancellation across later deployment-list polls', () => {
  const options = {
    baselineIds: IDS.slice(0, 2).join(','),
    expectedImage: EXPECTED_IMAGE,
    captureStartedAt: '2026-05-31T10:00:30.000Z',
  };
  const cancelled = deployment(IDS[2], 'Other("CANCELLED")', '2026-05-31T10:01:00.000Z');

  assert.throws(
    () => findNewDeployment({ deployments: [cancelled] }, options),
    /sole new Railway deployment was cancelled; quarantining its ID/,
  );

  const quarantinedOptions = { ...options, observedCancelledId: IDS[2] };
  assert.throws(
    () => findNewDeployment({ deployments: [cancelled] }, quarantinedOptions),
    /sole new Railway deployment was cancelled; quarantining its ID/,
  );
  // ...but the quarantined row beside exactly one live successor is one
  // redeploy, not two: Railway cancelled the queue entry the successor
  // replaced. Resolve to the successor rather than failing an ordinary
  // redeploy closed (#5040).
  assert.equal(
    findNewDeployment(
      {
        deployments: [deployment(IDS[3], 'BUILDING', '2026-05-31T10:02:00.000Z'), cancelled],
      },
      quarantinedOptions,
    ).id,
    IDS[3],
  );
  assert.throws(
    () =>
      findNewDeployment(
        { deployments: [deployment(IDS[3], 'BUILDING', '2026-05-31T10:02:00.000Z')] },
        quarantinedOptions,
      ),
    /deployment set changed after a cancellation was quarantined/,
  );
  assert.throws(
    () =>
      findNewDeployment(
        { deployments: [deployment(IDS[2], 'SUCCESS', '2026-05-31T10:01:00.000Z')] },
        quarantinedOptions,
      ),
    /deployment set changed after a cancellation was quarantined/,
  );
});

void test('CLI emits only the quarantine ID for a wrapped cancellation', () => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'railway-status-cancelled-'));
  const fixturePath = join(fixtureDirectory, 'deployments.json');
  try {
    writeFileSync(
      fixturePath,
      JSON.stringify({
        deployments: [deployment(IDS[2], 'Other("CANCELLED")', '2026-05-31T10:01:00.000Z')],
      }),
    );
    const cliResult = spawnSync(process.execPath, [STATUS_SCRIPT_PATH, 'find-new', fixturePath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BASELINE_DEPLOYMENT_IDS: IDS.slice(0, 2).join(','),
        EXPECTED_IMAGE,
        LOCKED_DEPLOYMENT_ID: '',
        OBSERVED_CANCELLED_DEPLOYMENT_ID: '',
        CAPTURE_STARTED_AT: '2026-05-31T10:00:30.000Z',
      },
    });

    assert.notEqual(cliResult.status, 0);
    assert.match(cliResult.stdout, /CANCELLATION_QUARANTINE_REQUESTED='true'/);
    assert.match(cliResult.stdout, new RegExp(`OBSERVED_CANCELLED_DEPLOYMENT_ID='${IDS[2]}'`));
    assert.doesNotMatch(cliResult.stdout, /CURRENT_ID=/);
    assert.match(cliResult.stderr, /sole new Railway deployment was cancelled/);
  } finally {
    rmSync(fixtureDirectory, { recursive: true });
  }
});

void test('accepts exactly one post-baseline deployment after every baseline ID ages out', () => {
  const discovered = findNewDeployment(
    {
      deployments: [deployment(IDS[2], 'SUCCESS', '2026-05-31T10:01:00.000Z')],
    },
    {
      baselineIds: IDS.slice(0, 2).join(','),
      expectedImage: EXPECTED_IMAGE,
      captureStartedAt: '2026-05-31T10:00:30.000Z',
    },
  );

  assert.equal(discovered.id, IDS[2]);
  assert.equal(discovered.status, 'SUCCESS');
});

void test('rejects two post-baseline deployments when every baseline ID aged out', () => {
  assert.throws(
    () =>
      findNewDeployment(
        {
          deployments: [
            deployment(IDS[3], 'SUCCESS', '2026-05-31T10:02:00.000Z'),
            deployment(IDS[2], 'FAILED', '2026-05-31T10:01:00.000Z'),
          ],
        },
        {
          baselineIds: IDS.slice(0, 2).join(','),
          expectedImage: EXPECTED_IMAGE,
          captureStartedAt: '2026-05-31T10:00:30.000Z',
        },
      ),
    /multiple new deployments/,
  );
});

void test('resolves a superseded cancellation to its live successor without quarantining first', () => {
  // The pair can land in a single deployment-list read, before any poll has
  // recorded a quarantine. Counting the cancelled queue entry as a second new
  // deployment would fail an ordinary redeploy closed.
  const options = {
    baselineIds: IDS.slice(0, 2).join(','),
    expectedImage: EXPECTED_IMAGE,
    captureStartedAt: '2026-05-31T10:00:30.000Z',
  };

  for (const cancelledStatus of ['CANCELLED', 'CANCELED', 'Other("CANCELLED")']) {
    // Either list order picks the same deployment.
    assert.equal(
      findNewDeployment(
        {
          deployments: [
            deployment(IDS[3], cancelledStatus, '2026-05-31T10:02:00.000Z'),
            deployment(IDS[2], 'BUILDING', '2026-05-31T10:01:00.000Z'),
          ],
        },
        options,
      ).id,
      IDS[2],
    );
    assert.equal(
      findNewDeployment(
        {
          deployments: [
            deployment(IDS[2], 'BUILDING', '2026-05-31T10:01:00.000Z'),
            deployment(IDS[3], cancelledStatus, '2026-05-31T10:02:00.000Z'),
          ],
        },
        options,
      ).id,
      IDS[2],
    );
  }

  // Two live successors are still genuinely ambiguous.
  assert.throws(
    () =>
      findNewDeployment(
        {
          deployments: [
            deployment(IDS[3], 'QUEUED', '2026-05-31T10:02:00.000Z'),
            deployment(IDS[2], 'BUILDING', '2026-05-31T10:01:00.000Z'),
          ],
        },
        options,
      ),
    /multiple new deployments/,
  );
});

void test('rejects multiple superseded cancellations during discovery or quarantine resolution', () => {
  const deployments = [
    deployment(IDS[4], 'CANCELLED', '2026-05-31T10:03:00.000Z'),
    deployment(IDS[3], 'CANCELED', '2026-05-31T10:02:00.000Z'),
    deployment(IDS[2], 'BUILDING', '2026-05-31T10:01:00.000Z'),
  ];
  const options = {
    baselineIds: IDS.slice(0, 2).join(','),
    expectedImage: EXPECTED_IMAGE,
    captureStartedAt: '2026-05-31T10:00:30.000Z',
  };

  for (const observedCancelledId of [undefined, IDS[3]]) {
    assert.throws(
      () => findNewDeployment({ deployments }, { ...options, observedCancelledId }),
      /multiple new deployments/,
    );
  }
  assert.throws(
    () => findNewDeployment({ deployments: deployments.slice(0, 2) }, { ...options, observedCancelledId: IDS[3] }),
    /multiple new deployments/,
  );
});

void test('CLI does not request another quarantine for a generic ambiguity after one was observed', () => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'railway-status-ambiguous-cancellations-'));
  const fixturePath = join(fixtureDirectory, 'deployments.json');
  try {
    writeFileSync(
      fixturePath,
      JSON.stringify({
        deployments: [
          deployment(IDS[4], 'CANCELLED', '2026-05-31T10:03:00.000Z'),
          deployment(IDS[3], 'CANCELED', '2026-05-31T10:02:00.000Z'),
          deployment(IDS[2], 'BUILDING', '2026-05-31T10:01:00.000Z'),
        ],
      }),
    );
    const cliResult = spawnSync(process.execPath, [STATUS_SCRIPT_PATH, 'find-new', fixturePath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BASELINE_DEPLOYMENT_IDS: IDS.slice(0, 2).join(','),
        EXPECTED_IMAGE,
        LOCKED_DEPLOYMENT_ID: '',
        OBSERVED_CANCELLED_DEPLOYMENT_ID: IDS[3],
        CAPTURE_STARTED_AT: '2026-05-31T10:00:30.000Z',
      },
    });

    assert.notEqual(cliResult.status, 0);
    assert.doesNotMatch(cliResult.stdout, /CANCELLATION_QUARANTINE_REQUESTED=/);
    assert.doesNotMatch(cliResult.stdout, /OBSERVED_CANCELLED_DEPLOYMENT_ID=/);
    assert.match(cliResult.stderr, /multiple new deployments/);
  } finally {
    rmSync(fixtureDirectory, { recursive: true });
  }
});

void test('CLI does not refresh quarantine when a second cancellation appears without a live successor', () => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'railway-status-multiple-cancellations-'));
  const fixturePath = join(fixtureDirectory, 'deployments.json');
  try {
    writeFileSync(
      fixturePath,
      JSON.stringify({
        deployments: [
          deployment(IDS[4], 'CANCELLED', '2026-05-31T10:03:00.000Z'),
          deployment(IDS[3], 'CANCELED', '2026-05-31T10:02:00.000Z'),
        ],
      }),
    );
    const cliResult = spawnSync(process.execPath, [STATUS_SCRIPT_PATH, 'find-new', fixturePath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BASELINE_DEPLOYMENT_IDS: IDS.slice(0, 2).join(','),
        EXPECTED_IMAGE,
        LOCKED_DEPLOYMENT_ID: '',
        OBSERVED_CANCELLED_DEPLOYMENT_ID: IDS[3],
        CAPTURE_STARTED_AT: '2026-05-31T10:00:30.000Z',
      },
    });

    assert.notEqual(cliResult.status, 0);
    assert.doesNotMatch(cliResult.stdout, /CANCELLATION_QUARANTINE_REQUESTED=/);
    assert.doesNotMatch(cliResult.stdout, /OBSERVED_CANCELLED_DEPLOYMENT_ID=/);
    assert.match(cliResult.stderr, /multiple new deployments/);
  } finally {
    rmSync(fixtureDirectory, { recursive: true });
  }
});

void test('does not treat a superseded cancellation as a concurrent deployment after locking', () => {
  // The locked deployment and the queue entry it superseded are the same
  // redeploy, so the post-lock fence must let the pair through — otherwise
  // locking the deployment that actually ran fails on the very next poll.
  const lockedOptions = {
    baselineIds: IDS.slice(0, 2).join(','),
    expectedImage: EXPECTED_IMAGE,
    lockedId: IDS[2],
  };
  const locked = findNewDeployment(
    {
      deployments: [
        deployment(IDS[3], 'CANCELLED', '2026-05-31T10:02:00.000Z'),
        deployment(IDS[2], 'DEPLOYING', '2026-05-31T10:01:00.000Z'),
      ],
    },
    lockedOptions,
  );
  assert.equal(locked.id, IDS[2]);
  assert.equal(locked.status, 'DEPLOYING');

  // A live sibling still trips the fence.
  assert.throws(
    () =>
      findNewDeployment(
        {
          deployments: [
            deployment(IDS[3], 'BUILDING', '2026-05-31T10:02:00.000Z'),
            deployment(IDS[2], 'DEPLOYING', '2026-05-31T10:01:00.000Z'),
          ],
        },
        lockedOptions,
      ),
    /concurrent Railway deployment/,
  );
});

void test('rejects multiple superseded cancellations after locking the live successor', () => {
  assert.throws(
    () =>
      findNewDeployment(
        {
          deployments: [
            deployment(IDS[4], 'CANCELLED', '2026-05-31T10:03:00.000Z'),
            deployment(IDS[3], 'CANCELED', '2026-05-31T10:02:00.000Z'),
            deployment(IDS[2], 'DEPLOYING', '2026-05-31T10:01:00.000Z'),
          ],
        },
        {
          baselineIds: IDS.slice(0, 2).join(','),
          expectedImage: EXPECTED_IMAGE,
          lockedId: IDS[2],
        },
      ),
    /multiple new deployments/,
  );
});
