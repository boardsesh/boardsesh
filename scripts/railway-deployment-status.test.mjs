import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capturePreviousDeployment, findNewDeployment } from './railway-deployment-status.mjs';

void test('finds only a deployment newer than the captured previous deployment', () => {
  const previous = capturePreviousDeployment({
    deployments: [
      { id: 'deploy-2', status: 'SUCCESS', createdAt: '2026-05-31T10:00:00.000Z' },
      { id: 'deploy-1', status: 'SUCCESS', createdAt: '2026-05-31T09:00:00.000Z' },
    ],
  });

  assert.deepEqual(
    findNewDeployment(
      {
        deployments: [
          { id: 'deploy-2', status: 'SUCCESS', createdAt: '2026-05-31T10:00:00.000Z' },
          { id: 'deploy-1', status: 'SUCCESS', createdAt: '2026-05-31T09:00:00.000Z' },
        ],
      },
      previous,
    ),
    { id: '', status: '', createdAt: '' },
  );

  assert.deepEqual(
    findNewDeployment(
      {
        deployments: [
          { id: 'deploy-3', status: 'BUILDING', createdAt: '2026-05-31T10:01:00.000Z' },
          { id: 'deploy-2', status: 'SUCCESS', createdAt: '2026-05-31T10:00:00.000Z' },
          { id: 'deploy-1', status: 'SUCCESS', createdAt: '2026-05-31T09:00:00.000Z' },
        ],
      },
      previous,
    ),
    { id: 'deploy-3', status: 'BUILDING', createdAt: '2026-05-31T10:01:00.000Z' },
  );
});

void test('fails explicitly when the previous Railway deployment cannot be captured', () => {
  assert.throws(
    () => capturePreviousDeployment({ deployments: [] }),
    /could not capture previous Railway deployment ID/,
  );
});

void test('prefers a non-cancelled deployment over a cancelled one that superseded it', () => {
  const previous = capturePreviousDeployment({
    deployments: [{ id: 'deploy-1', status: 'SUCCESS', createdAt: '2026-05-31T09:00:00.000Z' }],
  });

  // Railway can list a cancelled superseded deployment ahead of the one that
  // actually ran (e.g. it was queued first, then bumped). Picking the first
  // "newer than previous" match by list order alone would get stuck reporting
  // CANCELLED forever even though deploy-3 already succeeded.
  assert.deepEqual(
    findNewDeployment(
      {
        deployments: [
          { id: 'deploy-2', status: 'CANCELLED', createdAt: '2026-05-31T10:01:00.000Z' },
          { id: 'deploy-3', status: 'SUCCESS', createdAt: '2026-05-31T10:00:00.000Z' },
          { id: 'deploy-1', status: 'SUCCESS', createdAt: '2026-05-31T09:00:00.000Z' },
        ],
      },
      previous,
    ),
    { id: 'deploy-3', status: 'SUCCESS', createdAt: '2026-05-31T10:00:00.000Z' },
  );
});

void test('reports CANCELLED when every deployment newer than previous was cancelled', () => {
  const previous = capturePreviousDeployment({
    deployments: [{ id: 'deploy-1', status: 'SUCCESS', createdAt: '2026-05-31T09:00:00.000Z' }],
  });

  assert.deepEqual(
    findNewDeployment(
      {
        deployments: [
          { id: 'deploy-2', status: 'CANCELLED', createdAt: '2026-05-31T10:00:00.000Z' },
          { id: 'deploy-1', status: 'SUCCESS', createdAt: '2026-05-31T09:00:00.000Z' },
        ],
      },
      previous,
    ),
    { id: 'deploy-2', status: 'CANCELLED', createdAt: '2026-05-31T10:00:00.000Z' },
  );
});

void test('treats every remaining deployment as newer once the previous one ages out of the list with no usable timestamp', () => {
  const previous = { id: 'deploy-1', createdAt: '' };

  // previous.id is not present anywhere in this 10-item page (it aged out),
  // and createdAt is empty on both sides, so neither the timestamp nor the
  // index comparison can settle it. Returning false here (the old behaviour)
  // means the poll never finds a "newer" deployment and exhausts every
  // attempt even after the redeploy already succeeded.
  assert.deepEqual(
    findNewDeployment(
      {
        deployments: [{ id: 'deploy-11', status: 'SUCCESS', createdAt: '' }],
      },
      previous,
    ),
    { id: 'deploy-11', status: 'SUCCESS', createdAt: '' },
  );
});

void test('picks the newest (list-first) non-cancelled candidate once the previous deployment ages out with no usable timestamp', () => {
  const previous = { id: 'deploy-1', createdAt: '' };

  // Every remaining entry counts as "newer than previous" here (see the test
  // above), so with several candidates the CANCELLED-preference pick is what
  // has to fall back to Railway's newest-first list order — deploy-12 (index
  // 0) must win over deploy-11 (index 1), not the other way round.
  assert.deepEqual(
    findNewDeployment(
      {
        deployments: [
          { id: 'deploy-12', status: 'SUCCESS', createdAt: '' },
          { id: 'deploy-11', status: 'SUCCESS', createdAt: '' },
        ],
      },
      previous,
    ),
    { id: 'deploy-12', status: 'SUCCESS', createdAt: '' },
  );

  // Same shape, but the newest (list-first) entry is a cancelled superseded
  // one — the non-cancelled preference must still pick deploy-11 over it.
  assert.deepEqual(
    findNewDeployment(
      {
        deployments: [
          { id: 'deploy-12', status: 'CANCELLED', createdAt: '' },
          { id: 'deploy-11', status: 'SUCCESS', createdAt: '' },
        ],
      },
      previous,
    ),
    { id: 'deploy-11', status: 'SUCCESS', createdAt: '' },
  );
});
