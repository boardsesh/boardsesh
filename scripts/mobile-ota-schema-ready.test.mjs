import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSchemaReady, schemaReady, schemasCompatible } from './mobile-ota-schema-ready.mjs';

const RELEASE = 'a'.repeat(40);

void test('requires a stamped live release and matching complete schema', () => {
  assert.equal(schemaReady({ release: RELEASE, sameSchema: true }), true);
  assert.equal(schemaReady({ release: RELEASE, sameSchema: false }), false);
  assert.equal(schemaReady({ release: 'development', sameSchema: true }), false);
  assert.equal(schemaReady({ release: '', sameSchema: true }), false);
});

const CLIENT_SCHEMA = `
  enum NotificationType { new_follower }
  input Filter { limit: Int }
  type Query { notifications(filter: Filter): [NotificationType!]! }
`;

void test('an older native client remains compatible with documentation and additive schema changes', async () => {
  const backendSchema = `
    "A new reply can notify the reporter."
    enum NotificationType { new_follower app_feedback_reply }
    input Filter { limit: Int reporterId: ID }
    type Query {
      notifications(filter: Filter): [NotificationType!]!
      appBugReport(id: ID!): String
    }
  `;
  assert.equal(await schemasCompatible(CLIENT_SCHEMA, backendSchema), true);
  // The new client must still wait for its new backend fields.
  assert.equal(await schemasCompatible(backendSchema, CLIENT_SCHEMA), false);
});

void test('native recovery refuses removed fields, changed types, and new required inputs', async () => {
  for (const backendSchema of [
    CLIENT_SCHEMA.replace('notifications(filter: Filter)', 'renamedNotifications(filter: Filter)'),
    CLIENT_SCHEMA.replace('[NotificationType!]!', 'String'),
    CLIENT_SCHEMA.replace('limit: Int', 'limit: Int reporterId: ID!'),
    CLIENT_SCHEMA.replace('filter: Filter', 'filter: Filter!'),
    CLIENT_SCHEMA.replace('new_follower', 'app_feedback_reply'),
  ]) {
    assert.equal(await schemasCompatible(CLIENT_SCHEMA, backendSchema), false);
  }
});

void test('unparseable or invalid schema evidence fails closed', async () => {
  await assert.rejects(schemasCompatible(CLIENT_SCHEMA, 'type Query { broken: }'));
  await assert.rejects(schemasCompatible('type Query { unknown: MissingType }', CLIENT_SCHEMA));
});

void test('compatibility requires an explicit opt-in and exact revision schema evidence', async () => {
  const sourceSha = 'b'.repeat(40);
  const reads = [];
  const readGit = (...args) => {
    reads.push(args);
    if (args[0] === 'diff') throw Object.assign(new Error('schemas differ'), { status: 1 });
    if (args[0] === 'show') {
      return args[1].startsWith(`${sourceSha}:`)
        ? CLIENT_SCHEMA
        : CLIENT_SCHEMA.replace('limit: Int', 'limit: Int reporterId: ID');
    }
    return '';
  };
  assert.equal(await checkSchemaReady({ release: RELEASE, sourceSha, readGit }), false);
  assert.equal(
    reads.some(([operation]) => operation === 'show'),
    false,
  );
  assert.equal(await checkSchemaReady({ release: RELEASE, sourceSha, readGit, allowCompatibleSchema: true }), true);
  assert.deepEqual(
    reads.filter(([operation]) => operation === 'show'),
    [
      ['show', `${sourceSha}:packages/shared-schema/src/generated/schema.graphql`],
      ['show', `${RELEASE}:packages/shared-schema/src/generated/schema.graphql`],
    ],
  );
});

void test('git failures cannot be mistaken for a compatible schema difference', async () => {
  const failure = Object.assign(new Error('missing release revision'), { status: 128 });
  for (const failedOperation of ['cat-file', 'diff', 'show']) {
    const readGit = (operation) => {
      if (operation === failedOperation) throw failure;
      if (operation === 'diff') throw Object.assign(new Error('schemas differ'), { status: 1 });
      return '';
    };
    await assert.rejects(
      checkSchemaReady({ release: RELEASE, sourceSha: 'b'.repeat(40), readGit, allowCompatibleSchema: true }),
      failure,
    );
  }
});
