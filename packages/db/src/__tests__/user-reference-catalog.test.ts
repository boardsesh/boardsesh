import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { foreignKey, pgSchema, pgTable, text } from 'drizzle-orm/pg-core';
import * as schema from '../schema/index';
import {
  compareUserReferences,
  collectUserReferenceCatalog,
  decodeCatalogRow,
  MANUAL_USER_REFERENCES,
  portableCatalogDigest,
  readCatalogPhysical,
  readExpectedUserReferences,
  referenceIdentity,
  type CatalogServerState,
  type UserReference,
  type UserReferenceCatalog,
} from '../user-reference-catalog';

const reference: UserReference = {
  schema: 'public',
  table: 'comments',
  columns: ['user_id'],
  referencedSchema: 'public',
  referencedTable: 'users',
  referencedColumns: ['id'],
  onUpdate: 'no action',
  onDelete: 'cascade',
  match: 'simple',
  validated: true,
  deferrable: false,
  initiallyDeferred: false,
  deleteSetColumns: null,
};

function catalogFixture(): UserReferenceCatalog {
  return {
    version: 1,
    physical: {
      database: 'owned_fixture_a',
      databaseOid: 100,
      systemIdentifier: '111',
      usersOid: 200,
      serverVersion: 180006,
      transport: 'unix-socket',
      recovery: false,
      clientAddress: null,
    },
    snapshot: { isolation: 'repeatable read', readOnly: 'on', rowSecurity: 'off' },
    references: [
      {
        ...reference,
        oid: 300,
        name: 'comments_user_fk',
        parentConstraint: null,
        definition: 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
      },
    ],
    triggers: [
      {
        schema: 'public',
        table: 'comments',
        name: 'RI_ConstraintTrigger_c_301',
        identity: '"RI_ConstraintTrigger_c_301" on public.comments',
        internal: true,
        enabled: 'O',
        type: 5,
        deferrable: false,
        initiallyDeferred: false,
        constraint: 'public.comments.comments_user_fk',
        functionIdentity: 'pg_catalog.RI_FKey_check_ins()',
        functionDefinitionHash: 'stable_builtin_digest',
        arguments: '',
        definition: 'generated trigger 301',
      },
    ],
    routines: [
      {
        identity: 'public.example()',
        kind: 'f',
        owner: 'postgres',
        language: 'sql',
        securityDefiner: false,
        volatility: 'v',
        strict: false,
        parallel: 'u',
        configuration: [],
        acl: [],
        definition: 'SELECT 1',
        extension: null,
      },
    ],
    eventTriggers: [],
    dependencies: [],
    relations: [],
    extensions: [],
    extensionRoutineCounts: [],
    policies: [],
    defaultPrivileges: [],
    ledgers: {
      public: [{ hash: 'migration_a', createdAt: '123' }],
      drizzle: [{ hash: 'migration_a', createdAt: '123' }],
    },
  };
}

void describe('canonical user-reference contract', () => {
  void it('includes the migration-managed beta attribution once alongside actual schema declarations', () => {
    const expected = readExpectedUserReferences(schema);
    assert.ok(expected.length > 60, 'actual schema import must contribute the canonical contract');
    const manualIdentity = referenceIdentity(MANUAL_USER_REFERENCES[0]);
    const betaReferences = expected.filter((entry) => referenceIdentity(entry) === manualIdentity);
    assert.equal(betaReferences.length, 1);
    assert.deepEqual(betaReferences[0], MANUAL_USER_REFERENCES[0]);
  });

  void it('accounts for the retained controller artifact and still rejects missing, third or altered constraints', () => {
    const expected = readExpectedUserReferences(schema);
    const grouped = new Map<string, UserReference[]>();
    for (const entry of expected) {
      const identity = referenceIdentity(entry);
      grouped.set(identity, [...(grouped.get(identity) ?? []), entry]);
    }
    const duplicates = [...grouped.values()].filter((entries) => entries.length > 1);
    assert.equal(duplicates.length, 1);
    const controllers = duplicates[0];
    assert.equal(controllers[0].table, 'esp32_controllers');
    assert.deepEqual(controllers[0].columns, ['user_id']);
    assert.equal(controllers.length, 2);
    assert.deepEqual(compareUserReferences(controllers, controllers), []);
    assert.equal(compareUserReferences(controllers, controllers.slice(0, 1))[0].kind, 'missing');
    assert.equal(compareUserReferences(controllers, [...controllers, controllers[0]])[0].kind, 'unexpected');
    for (const changed of [
      { ...controllers[1], validated: false },
      { ...controllers[1], onDelete: 'set null' as const },
    ]) {
      assert.equal(compareUserReferences(controllers, [controllers[0], changed])[0].kind, 'different');
    }
  });

  void it('does not manufacture controller support when the canonical identity is absent', () => {
    const users = pgTable('users', { id: text('id') });
    const comments = pgTable('comments', { userId: text('user_id').references(() => users.id) });
    assert.equal(
      readExpectedUserReferences({ users, comments }).some((entry) => entry.table === 'esp32_controllers'),
      false,
    );
  });

  void it('does not add a third controller constraint when both are declared canonically', () => {
    const users = pgTable('users', { id: text('id') });
    const controllers = pgTable(
      'esp32_controllers',
      {
        userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
      },
      (table) => [
        foreignKey({
          name: 'esp32_controllers_user_id_fkey',
          columns: [table.userId],
          foreignColumns: [users.id],
        }).onDelete('cascade'),
      ],
    );
    assert.equal(
      readExpectedUserReferences({ users, controllers }).filter((entry) => entry.table === 'esp32_controllers').length,
      2,
    );
  });

  void it('reflects ordered composite keys and actions, deduplicating aliased exports', () => {
    const users = pgTable('users', { id: text('id'), tenantId: text('tenant_id') });
    const comments = pgTable('comments', { userId: text('user_id'), tenantId: text('tenant_id') }, (table) => [
      foreignKey({ columns: [table.tenantId, table.userId], foreignColumns: [users.tenantId, users.id] })
        .onDelete('restrict')
        .onUpdate('cascade'),
    ]);
    const expected = readExpectedUserReferences({ users, comments, commentsAlias: comments, unrelated: 'text' });
    const commentsReferences = expected.filter((entry) => entry.table === 'comments');
    assert.equal(commentsReferences.length, 1);
    assert.deepEqual(commentsReferences[0].columns, ['tenant_id', 'user_id']);
    assert.deepEqual(commentsReferences[0].referencedColumns, ['tenant_id', 'id']);
    assert.equal(commentsReferences[0].onDelete, 'restrict');
    assert.equal(commentsReferences[0].onUpdate, 'cascade');
  });

  void it('does not accept an empty module or treat another schema users table as public.users', () => {
    assert.throws(() => readExpectedUserReferences({}), /No canonical/);
    const otherUsers = pgSchema('other').table('users', { id: text('id') });
    const comments = pgTable('comments', { userId: text('user_id').references(() => otherUsers.id) });
    assert.throws(() => readExpectedUserReferences({ otherUsers, comments }), /No canonical/);
  });

  void it('uses a future canonical beta declaration instead of duplicating the exception', () => {
    const users = pgTable('users', { id: text('id') });
    const betaLinks = pgTable('board_beta_links', {
      createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    });
    const expected = readExpectedUserReferences({ users, betaLinks });
    assert.equal(expected.length, 1);
    assert.deepEqual(expected[0], MANUAL_USER_REFERENCES[0]);
  });
});

void describe('physical reference reconciliation', () => {
  void it('accepts equivalent constraints independently of row order and physical metadata', () => {
    const second = { ...reference, table: 'reactions' };
    const physical = { ...reference, oid: 123, name: 'server_name', definition: 'physical' };
    assert.deepEqual(compareUserReferences([reference, second], [second, physical]), []);
  });

  void it('detects missing, extra and duplicate constraints without a count shortcut', () => {
    assert.equal(compareUserReferences([reference], [])[0].kind, 'missing');
    assert.equal(compareUserReferences([], [reference])[0].kind, 'unexpected');
    const duplicated = compareUserReferences([reference], [reference, reference]);
    assert.equal(duplicated.length, 1);
    assert.equal(duplicated[0].kind, 'unexpected');
  });

  for (const drift of [
    { onDelete: 'set null' },
    { onUpdate: 'cascade' },
    { validated: false },
    { deferrable: true },
    { initiallyDeferred: true },
    { match: 'full' },
    { deleteSetColumns: ['user_id'] },
  ] satisfies Partial<UserReference>[]) {
    void it(`detects structural drift ${JSON.stringify(drift)}`, () => {
      const differences = compareUserReferences([reference], [{ ...reference, ...drift }]);
      assert.equal(differences.length, 1);
      assert.equal(differences[0].kind, 'different');
      assert.deepEqual(differences[0].observed, { ...reference, ...drift });
    });
  }

  void it('distinguishes ordered composite columns and same-named tables in different schemas', () => {
    const composite = { ...reference, columns: ['tenant_id', 'user_id'], referencedColumns: ['tenant_id', 'id'] };
    assert.notEqual(
      referenceIdentity(composite),
      referenceIdentity({ ...composite, columns: ['user_id', 'tenant_id'] }),
    );
    assert.notEqual(referenceIdentity(reference), referenceIdentity({ ...reference, schema: 'other' }));
    assert.deepEqual(
      compareUserReferences([composite], [{ ...composite, columns: ['user_id', 'tenant_id'] }]).map(
        (difference) => difference.kind,
      ),
      ['missing', 'unexpected'],
    );
  });
});

void describe('portable catalog digest', () => {
  void it('separates real allocation identities and generated internal trigger names from structure', () => {
    const first = catalogFixture();
    const second = structuredClone(first);
    second.physical = {
      ...second.physical,
      database: 'owned_fixture_b',
      databaseOid: 700,
      usersOid: 800,
      systemIdentifier: '222',
    };
    second.references[0].oid = 900;
    second.triggers[0].name = 'RI_ConstraintTrigger_c_901';
    second.triggers[0].definition = 'generated trigger 901';
    assert.equal(portableCatalogDigest(first), portableCatalogDigest(second));
  });

  void it('retains FK state, trigger enablement, routines, policies, extensions and migration evidence', () => {
    const first = catalogFixture();
    const mutations: ((catalog: UserReferenceCatalog) => void)[] = [
      (catalog) => {
        catalog.references[0].validated = false;
      },
      (catalog) => {
        catalog.triggers[0].enabled = 'D';
      },
      (catalog) => {
        catalog.policies.push({ schema: 'public', table: 'comments', name: 'new', definition: 'false' });
      },
      (catalog) => {
        catalog.extensions.push({ name: 'postgis', version: 'different', schema: 'public', owner: 'postgres' });
      },
      (catalog) => {
        catalog.ledgers.drizzle[0].hash = 'different';
      },
      (catalog) => {
        catalog.routines[0].definition = 'SELECT 2';
      },
      (catalog) => {
        catalog.routines[0].securityDefiner = true;
      },
      (catalog) => {
        catalog.routines[0].configuration = ['search_path=public'];
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(first);
      mutate(changed);
      assert.notEqual(portableCatalogDigest(first), portableCatalogDigest(changed));
    }
  });

  void it('normalizes exact internal-trigger dependency identities independently of physical sorting', () => {
    const first = catalogFixture();
    const secondTrigger = {
      ...first.triggers[0],
      name: 'RI_ConstraintTrigger_c_3010',
      identity: '"RI_ConstraintTrigger_c_3010" on public.comments',
      type: 17,
      definition: 'generated trigger 3010',
    };
    first.triggers.push(secondTrigger);
    first.dependencies = first.triggers.map((trigger) => ({
      objectType: 'trigger',
      objectSchema: null,
      objectIdentity: `"${trigger.name}" on public.comments`,
      referencedType: 'function',
      referencedSchema: 'pg_catalog',
      referencedIdentity: trigger.functionIdentity,
      kind: 'n',
    }));
    const second = structuredClone(first);
    second.triggers[0].name = 'RI_ConstraintTrigger_c_900';
    second.triggers[1].name = 'RI_ConstraintTrigger_c_90';
    second.triggers[0].identity = '"RI_ConstraintTrigger_c_900" on public.comments';
    second.triggers[1].identity = '"RI_ConstraintTrigger_c_90" on public.comments';
    second.dependencies[0].objectIdentity = '"RI_ConstraintTrigger_c_900" on public.comments';
    second.dependencies[1].objectIdentity = '"RI_ConstraintTrigger_c_90" on public.comments';
    second.dependencies.reverse();
    second.triggers.reverse();
    assert.equal(portableCatalogDigest(first), portableCatalogDigest(second));
    second.dependencies[0].kind = 'a';
    assert.notEqual(portableCatalogDigest(first), portableCatalogDigest(second));
  });

  void it('retains non-trigger dependency identities that share a generated trigger name', () => {
    const first = catalogFixture();
    first.dependencies.push({
      objectType: 'function',
      objectSchema: 'public',
      objectIdentity: first.triggers[0].identity,
      referencedType: 'type',
      referencedSchema: 'pg_catalog',
      referencedIdentity: 'integer',
      kind: 'n',
    });
    const second = structuredClone(first);
    second.triggers[0].name = 'RI_ConstraintTrigger_c_900';
    second.triggers[0].identity = '"RI_ConstraintTrigger_c_900" on public.comments';
    second.dependencies[0].objectIdentity = second.triggers[0].identity;
    assert.notEqual(portableCatalogDigest(first), portableCatalogDigest(second));
  });
});

void describe('catalog connection evidence', () => {
  const state: CatalogServerState = {
    database: 'catalog',
    databaseOid: 100,
    systemIdentifier: '111',
    usersOid: 200,
    serverVersion: 180006,
    recovery: false,
    clientAddress: null,
    isolation: 'repeatable read',
    readOnly: 'on',
    rowSecurity: 'off',
  };

  void it('keeps the owned fixture to a primary reached over a Unix socket', () => {
    assert.deepEqual(readCatalogPhysical(state, 'unix-socket'), {
      database: 'catalog',
      databaseOid: 100,
      usersOid: 200,
      serverVersion: 180006,
      transport: 'unix-socket',
      recovery: false,
      clientAddress: null,
      systemIdentifier: '111',
    });
    for (const rejected of [
      { ...state, clientAddress: '10.0.0.1' },
      { ...state, recovery: true },
      { ...state, systemIdentifier: null },
    ]) {
      assert.throws(() => readCatalogPhysical(rejected, 'unix-socket'), /primary Unix-socket/);
    }
  });

  void it('reports what a TCP connection observed, including a standby and an unreadable identifier', () => {
    assert.deepEqual(
      readCatalogPhysical({ ...state, clientAddress: '10.0.0.1', recovery: true, systemIdentifier: null }, 'tcp'),
      {
        database: 'catalog',
        databaseOid: 100,
        usersOid: 200,
        serverVersion: 180006,
        transport: 'tcp',
        recovery: true,
        clientAddress: '10.0.0.1',
        systemIdentifier: null,
      },
    );
    assert.equal(readCatalogPhysical({ ...state, clientAddress: '10.0.0.1' }, 'tcp').recovery, false);
  });

  void it('rejects a TCP claim the server does not confirm', () => {
    assert.throws(() => readCatalogPhysical(state, 'tcp'), /read-only TCP/);
  });

  void it('requires the same read-only snapshot on both transports', () => {
    const tcp = { ...state, clientAddress: '10.0.0.1' };
    for (const drift of [
      { readOnly: 'off' },
      { isolation: 'read committed' },
      { rowSecurity: 'on' },
      { usersOid: null },
      { serverVersion: 170000 },
      { systemIdentifier: 'not-digits' },
    ] satisfies Partial<CatalogServerState>[]) {
      assert.throws(() => readCatalogPhysical({ ...state, ...drift }, 'unix-socket'), /read-only snapshot/);
      assert.throws(() => readCatalogPhysical({ ...tcp, ...drift }, 'tcp'), /read-only snapshot/);
    }
    assert.throws(() => readCatalogPhysical(undefined, 'tcp'), /read-only snapshot/);
  });
});

void describe('catalog runtime row decoding', () => {
  void it('rejects missing, extra, wrong primitive, null and invalid enum fields', () => {
    const shape = { name: 'string', enabled: ['O', 'D'], count: 'number', columns: 'strings' } as const;
    const valid = { name: 'fixture', enabled: 'O', count: 1, columns: ['id'] };
    const inheritedName: unknown = Object.assign(Object.create({ name: valid.name }) as Record<string, unknown>, {
      enabled: valid.enabled,
      count: valid.count,
      columns: valid.columns,
      extra: true,
    });
    assert.deepEqual(decodeCatalogRow(valid, shape), valid);
    for (const malformed of [
      null,
      inheritedName,
      [],
      {},
      { ...valid, count: NaN },
      { ...valid, count: '1' },
      { ...valid, name: null },
      { ...valid, enabled: null },
      { ...valid, enabled: 'unknown' },
      { ...valid, columns: [1] },
      { ...valid, extra: true },
    ]) {
      assert.throws(() => decodeCatalogRow(malformed, shape), /Malformed catalog row/);
    }
  });

  void it('rejects invalid or excessive caller limits before opening a transaction', async () => {
    for (const limits of [
      { maximumRows: 0 },
      { maximumRows: 50_001 },
      { maximumBytes: 33 * 1024 * 1024 },
      { statementTimeoutMs: 10_001 },
      { maximumRows: NaN },
      { maximumBytes: Infinity },
    ]) {
      await assert.rejects(
        () =>
          collectUserReferenceCatalog(
            undefined as unknown as Parameters<typeof collectUserReferenceCatalog>[0],
            limits,
          ),
        /Invalid catalog limit/,
      );
    }
  });
});
