import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schemaReady } from './mobile-ota-schema-ready.mjs';

const RELEASE = 'a'.repeat(40);

test('requires a stamped live release and matching complete schema', () => {
  assert.equal(schemaReady({ release: RELEASE, sameSchema: true }), true);
  assert.equal(schemaReady({ release: RELEASE, sameSchema: false }), false);
  assert.equal(schemaReady({ release: 'development', sameSchema: true }), false);
  assert.equal(schemaReady({ release: '', sameSchema: true }), false);
});
