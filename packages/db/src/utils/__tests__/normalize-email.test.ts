import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail } from '../normalize-email.js';

test('lower-cases the address', () => {
  assert.equal(normalizeEmail('Foo@X.com'), 'foo@x.com');
  assert.equal(normalizeEmail('PMBMOSK@GMAIL.COM'), 'pmbmosk@gmail.com');
});

test('trims surrounding whitespace', () => {
  assert.equal(normalizeEmail('  foo@x.com  '), 'foo@x.com');
  assert.equal(normalizeEmail('\tFoo@X.com\n'), 'foo@x.com');
});

test('is idempotent', () => {
  const once = normalizeEmail('  Foo@X.com ');
  assert.equal(normalizeEmail(once), once);
});

test('two case variants normalise to the same value', () => {
  assert.equal(normalizeEmail('Pmbmosk@gmail.com'), normalizeEmail('pmbmosk@gmail.com'));
});

test('throws on a non-string input', () => {
  // @ts-expect-error exercising the runtime guard
  assert.throws(() => normalizeEmail(undefined), TypeError);
  // @ts-expect-error exercising the runtime guard
  assert.throws(() => normalizeEmail(null), TypeError);
});
