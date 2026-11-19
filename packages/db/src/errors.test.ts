import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getPostgresConstraintName, getPostgresErrorCode, isUniqueViolation } from './errors';

void test('recognizes only the named unique constraint through Drizzle causes', () => {
  const driver = { code: '23505', constraint_name: 'users_email_lower_key' };
  const wrapped = new Error('query failed', { cause: new Error('wrapper', { cause: driver }) });
  assert.equal(getPostgresErrorCode(wrapped), '23505');
  assert.equal(getPostgresConstraintName(wrapped), 'users_email_lower_key');
  assert.equal(isUniqueViolation(wrapped, 'users_email_lower_key'), true);
  assert.equal(isUniqueViolation({ code: '23505', constraint: 'users_pkey' }, 'users_email_lower_key'), false);
  assert.equal(
    isUniqueViolation({ code: '23514', constraint: 'users_email_lower_key' }, 'users_email_lower_key'),
    false,
  );
  assert.equal(isUniqueViolation(null), false);
});
void test('bounds malformed and cyclic cause chains', () => {
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  assert.equal(isUniqueViolation(cyclic), false);
  assert.equal(getPostgresErrorCode({ cause: 'invalid' }), undefined);
});
