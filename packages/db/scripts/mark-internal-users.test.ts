import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDITED_INTERNAL_EMAILS,
  applyInternalUserBackfill,
  parseMarkInternalUsersArgs,
  planInternalUserBackfill,
} from './mark-internal-users.js';

void test('the audit covers exactly the five approved addresses', () => {
  assert.deepEqual(AUDITED_INTERNAL_EMAILS, [
    'test22@boardsesh.com',
    'test@boardsesh.com',
    'system@boardsesh.com',
    'recommendations@boardsesh.com',
    'hold-classifier@boardsesh.com',
  ]);
});

void test('the plan leaves real climbers and unaudited addresses unchanged', () => {
  const candidates = [
    ...AUDITED_INTERNAL_EMAILS.map((email, index) => ({ id: `internal-${index}`, email, isInternal: false })),
    { id: 'kerry', email: 'testingkerry@gmail.com', isInternal: false },
    { id: 'rick', email: 'rick@pentester.com', isInternal: false },
    { id: 'staff', email: 'staff@boardsesh.com', isInternal: false },
    { id: 'lookalike', email: 'test@boardsesh.com.attacker.example', isInternal: false },
    { id: 'case-variant', email: 'Test@boardsesh.com', isInternal: false },
    { id: 'previous-audit', email: 'previously-audited@example.com', isInternal: true },
  ];
  const originalCandidates = structuredClone(candidates);

  const plan = planInternalUserBackfill(candidates);

  assert.deepEqual(
    plan.usersToMark.map((user) => user.email),
    AUDITED_INTERNAL_EMAILS,
  );
  assert.deepEqual(plan.alreadyInternal, []);
  assert.deepEqual(plan.missingEmails, []);
  assert.deepEqual(candidates, originalCandidates);
});

void test('the plan preserves existing internal flags and reports absent accounts', () => {
  const alreadyInternal = { id: 'system', email: 'system@boardsesh.com', isInternal: true };
  const plan = planInternalUserBackfill([alreadyInternal]);

  assert.deepEqual(plan.usersToMark, []);
  assert.deepEqual(plan.alreadyInternal, [alreadyInternal]);
  assert.deepEqual(
    plan.missingEmails,
    AUDITED_INTERNAL_EMAILS.filter((email) => email !== alreadyInternal.email),
  );
});

void test('default dry-run produces a concrete plan without calling the writer', async () => {
  const candidates = [{ id: 'test', email: 'test@boardsesh.com', isInternal: false }];
  const result = await applyInternalUserBackfill(candidates, {
    markInternal: () => {
      assert.fail('dry-run must not write');
    },
  });

  assert.deepEqual(result.plan.usersToMark, candidates);
  assert.equal(result.updatedCount, 0);
});

void test('apply only flags planned users and a second run performs no writes', async () => {
  const candidates = [
    { id: 'test', email: 'test@boardsesh.com', isInternal: false },
    { id: 'system', email: 'system@boardsesh.com', isInternal: true },
    { id: 'kerry', email: 'testingkerry@gmail.com', isInternal: false },
    { id: 'rick', email: 'rick@pentester.com', isInternal: false },
    { id: 'previous-audit', email: 'previously-audited@example.com', isInternal: true },
  ];
  const writes: string[][] = [];
  const markInternal = async (userIds: readonly string[]): Promise<number> => {
    writes.push([...userIds]);
    for (const user of candidates) {
      if (userIds.includes(user.id)) user.isInternal = true;
    }
    return userIds.length;
  };

  const firstRun = await applyInternalUserBackfill(candidates, { apply: true, markInternal });
  const secondRun = await applyInternalUserBackfill(candidates, { apply: true, markInternal });

  assert.deepEqual(writes, [['test']]);
  assert.equal(firstRun.updatedCount, 1);
  assert.equal(secondRun.updatedCount, 0);
  assert.deepEqual(
    candidates.map((user) => user.isInternal),
    [true, true, false, false, true],
  );
});

void test('CLI flags require explicit apply and accept the vp argument separator', () => {
  assert.deepEqual(parseMarkInternalUsersArgs([]), { apply: false, help: false });
  assert.deepEqual(parseMarkInternalUsersArgs(['--dry-run']), { apply: false, help: false });
  assert.deepEqual(parseMarkInternalUsersArgs(['--', '--apply']), { apply: true, help: false });
  assert.deepEqual(parseMarkInternalUsersArgs(['--help']), { apply: false, help: true });
  assert.throws(() => parseMarkInternalUsersArgs(['--apply', '--dry-run']), /Choose either/);
  assert.throws(() => parseMarkInternalUsersArgs(['--all']), /Expected/);
});
