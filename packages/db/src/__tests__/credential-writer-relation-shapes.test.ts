import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  reviewedCredentialWriterRelationShapes,
  type CredentialWriterContract,
  type ReviewedRelationShape,
} from '../credential-writer-acl';
import reviewedPrivateWebRelationShapes from '../credential-writer-private-web-v1';
import reviewedProviderRelationShapes from '../credential-writer-private-provider-v1';
import reviewedUsers0329RelationShapes from '../credential-writer-users-0329';

const historicalContracts = ['private-web-v1', 'private-browser-v1'] as const;
const canonicalContracts = [
  'private-provider-v1',
  'private-first-password-v1',
  'private-native-handoff-v1',
  'private-browser-renewal-v1',
] as const;

function shapeOf(shapes: readonly ReviewedRelationShape[], name: string) {
  const matches = shapes.filter((relation) => relation.name === name);
  assert.equal(matches.length, 1, `exactly one reviewed ${name} shape`);
  return matches[0]!.shape as { indexes: string[]; constraints: string[] };
}

void test('every contract lists each relation once, in catalog order', () => {
  for (const contract of [...historicalContracts, ...canonicalContracts] satisfies CredentialWriterContract[]) {
    const names = reviewedCredentialWriterRelationShapes(contract).map((relation) => relation.name);
    assert.equal(new Set(names).size, names.length, contract);
    assert.deepEqual(
      [...names].sort((left, right) => left.localeCompare(right)),
      names,
      contract,
    );
  }
});

void test('historical0312 profiles keep the pre-0329 users shape', () => {
  const historicalUsers = shapeOf(reviewedPrivateWebRelationShapes, 'users');
  assert.deepEqual(historicalUsers.indexes, ['CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)']);
  assert.deepEqual(historicalUsers.constraints, ['PRIMARY KEY (id)']);
  for (const contract of historicalContracts)
    assert.equal(shapeOf(reviewedCredentialWriterRelationShapes(contract), 'users'), historicalUsers, contract);
});

void test('canonical profiles take the reviewed 0329 users and 0313 security-event shapes', () => {
  const canonicalUsers = shapeOf(reviewedUsers0329RelationShapes, 'users');
  const canonicalEvents = shapeOf(reviewedProviderRelationShapes, 'auth_security_mutation_events');
  for (const contract of canonicalContracts) {
    const shapes = reviewedCredentialWriterRelationShapes(contract);
    assert.equal(shapeOf(shapes, 'users'), canonicalUsers, contract);
    assert.equal(shapeOf(shapes, 'auth_security_mutation_events'), canonicalEvents, contract);
  }
});

void test('the 0329 users receipt pins a unique lower(email) key and the JavaScript trim set', () => {
  const { indexes, constraints } = shapeOf(reviewedUsers0329RelationShapes, 'users');
  assert.deepEqual(indexes, [
    'CREATE UNIQUE INDEX users_email_lower_key ON public.users USING btree (lower(email))',
    'CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)',
  ]);
  const [check, primaryKey] = constraints;
  assert.equal(primaryKey, 'PRIMARY KEY (id)');
  const trimSet = /^CHECK \(\(email = lower\(btrim\(email, '([^']*)'::text\)\)\)\)$/u.exec(check ?? '')?.[1];
  // Every BMP code point String.prototype.trim removes, in code point order.
  const javascriptTrimSet = Array.from({ length: 0x10000 }, (_, codePoint) => String.fromCharCode(codePoint))
    .filter((character) => character.trim() === '')
    .join('');
  assert.equal(javascriptTrimSet.length, 25);
  assert.equal(trimSet, javascriptTrimSet);
});
