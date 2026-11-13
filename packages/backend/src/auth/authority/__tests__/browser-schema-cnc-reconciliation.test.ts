import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createEnvironment } from './environment';

const migrationDirectory = new URL('../../../../../db/drizzle/', import.meta.url);
const historicalDirectory = new URL('./fixtures/historical-private-browser-v1/', import.meta.url);
const readMigration = (tag: string) => readFileSync(new URL(`${tag}.sql`, migrationDirectory), 'utf8');
let previous: Awaited<ReturnType<typeof createEnvironment>>;
let regenerated: Awaited<ReturnType<typeof createEnvironment>>;

/** The same security-relevant columns/definitions pinned by the credential
 * qualifier, including physical column order. Object OIDs are database-local. */
async function protectedCatalog(environment: Awaited<ReturnType<typeof createEnvironment>>) {
  const catalog = await environment.client.unsafe<{ name: string; shape: unknown }[]>(`
    SELECT relation.relname AS name, json_build_object(
      'owner',pg_get_userbyid(relation.relowner),
      'rls',relation.relrowsecurity,'forcedRls',relation.relforcerowsecurity,
      'columns',(SELECT json_agg(json_build_array(attribute.attname,
        format_type(attribute.atttypid,attribute.atttypmod),attribute.attnotnull,
        attribute.attidentity,attribute.attgenerated,
        pg_get_expr(default_row.adbin,default_row.adrelid)) ORDER BY attribute.attnum)
        FROM pg_attribute attribute LEFT JOIN pg_attrdef default_row
          ON default_row.adrelid=attribute.attrelid AND default_row.adnum=attribute.attnum
        WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped),
      'constraints',(SELECT json_agg(json_build_array(constraint_row.conname,
        constraint_row.contype,pg_get_constraintdef(constraint_row.oid),
        constraint_row.convalidated,constraint_row.condeferrable,constraint_row.condeferred)
        ORDER BY constraint_row.conname)
        FROM pg_constraint constraint_row WHERE constraint_row.conrelid=relation.oid),
      'indexes',(SELECT json_agg(json_build_array(index_relation.relname,
        pg_get_indexdef(index_row.indexrelid),index_row.indisunique,index_row.indisvalid,
        index_row.indisready,index_row.indislive) ORDER BY index_relation.relname)
        FROM pg_index index_row JOIN pg_class index_relation ON index_relation.oid=index_row.indexrelid
        WHERE index_row.indrelid=relation.oid),
      'triggers',(SELECT json_agg(json_build_array(trigger_row.tgname,
        pg_get_triggerdef(trigger_row.oid),trigger_row.tgenabled,
        pg_get_functiondef(trigger_row.tgfoid)) ORDER BY trigger_row.tgname)
        FROM pg_trigger trigger_row WHERE trigger_row.tgrelid=relation.oid AND NOT trigger_row.tgisinternal)
    ) AS shape
    FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname='public' AND relation.relkind='r'
      AND (relation.relname LIKE 'auth\\_%' ESCAPE '\\' OR relation.relname LIKE 'oauth\\_%' ESCAPE '\\'
        OR relation.relname IN ('users','accounts','sessions','verificationTokens','user_credentials',
          'mobile_refresh_tokens','integration_credentials'))
    ORDER BY relation.relname`);
  return [...catalog];
}

describe('generated browser/provider migrations after the independent CNC migration', () => {
  beforeAll(async () => {
    [previous, regenerated] = await Promise.all([createEnvironment(), createEnvironment()]);
    await previous.client.unsafe(
      readFileSync(new URL('0311_browser_binding_selection.sql', historicalDirectory), 'utf8'),
    );
    await previous.client.unsafe(
      readFileSync(new URL('0312_browser_selection_possession.sql', historicalDirectory), 'utf8'),
    );
    await regenerated.client.unsafe(readMigration('0312_browser_binding_selection'));
    const providerSql = readMigration('0313_provider_security_receipts');
    expect(createHash('sha256').update(providerSql).digest('hex')).toBe(
      '1b920d45e8cba9139d4fbc4cc8ac3e487907cdfe469562aab2a3c8b338f3d113',
    );
    await previous.client.unsafe(providerSql);
    await regenerated.client.unsafe(providerSql);
  });
  afterAll(async () => {
    await Promise.all([previous?.close(), regenerated?.close()]);
  });

  it('keeps every protected table, physical column, default, constraint, index and trigger identical', async () => {
    const oldCatalog = await protectedCatalog(previous);
    const newCatalog = await protectedCatalog(regenerated);
    expect(oldCatalog.length).toBeGreaterThan(30);
    expect(newCatalog).toEqual(oldCatalog);
    const browserIntent = newCatalog.find((relation) => relation.name === 'auth_browser_intents');
    expect(browserIntent).toBeDefined();
    expect(browserIntent?.shape).toMatchObject({
      columns: expect.arrayContaining([
        ['format_version', 'integer', true, '', '', '1'],
        ['actor_credential_hash', 'text', false, '', '', null],
        ['result_credential_hash', 'text', false, '', '', null],
      ]),
    });
  });

  it('preserves old format defaults and rejects malformed proof digests in both schemas', async () => {
    for (const environment of [previous, regenerated]) {
      const bindingId = 'a'.repeat(64);
      await environment.client`INSERT INTO auth_browser_bindings (id,expires_at)
        VALUES (${bindingId},clock_timestamp()+interval '1 day')`;
      const [intent] = await environment.client<
        { format_version: number; actor_credential_hash: string | null; result_credential_hash: string | null }[]
      >`
        INSERT INTO auth_browser_intents (id,binding_id,revision,expected_version,operation,
          projection_id,authority,epoch,expires_at)
        VALUES (${'b'.repeat(64)},${bindingId},1,0,'login','owned-schema-projection','current-store',1,clock_timestamp()+interval '5 minutes')
        RETURNING format_version,actor_credential_hash,result_credential_hash`;
      expect(intent).toEqual({ format_version: 1, actor_credential_hash: null, result_credential_hash: null });
      await expect(environment.client`INSERT INTO auth_browser_intents
        (id,binding_id,revision,expected_version,operation,projection_id,authority,epoch,expires_at,format_version,actor_credential_hash)
        VALUES (${'c'.repeat(64)},${bindingId},2,0,'login','owned-schema-projection','current-store',1,
          clock_timestamp()+interval '5 minutes',2,'malformed-digest')`).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'auth_browser_intent_actor_hash',
      });
    }
  });

  it('authenticates the unchanged complete historical313 journal and SQL provenance', () => {
    const journal = JSON.parse(readFileSync(new URL('_journal.json', historicalDirectory), 'utf8')) as {
      entries: { tag: string; when: number }[];
    };
    expect(
      createHash('sha256')
        .update(JSON.stringify(journal, null, 2))
        .digest('hex'),
    ).toBe('ed600748d4863fa4dd7c7a4286041db19c1738085d57410554893d7916a4b5c8');
    expect(journal.entries).toHaveLength(313);
    expect(journal.entries.slice(-2).map((entry) => entry.tag)).toEqual([
      '0311_browser_binding_selection',
      '0312_browser_selection_possession',
    ]);
    const manifest = journal.entries.map((entry, index) => ({
      tag: entry.tag,
      when: entry.when,
      hash: createHash('sha256')
        .update(readFileSync(new URL(`${entry.tag}.sql`, index >= 311 ? historicalDirectory : migrationDirectory)))
        .digest('hex'),
    }));
    expect(createHash('sha256').update(JSON.stringify(manifest)).digest('hex')).toBe(
      '0e32ca2c7e0071b5404fbca9ae5e852d5a0af3a1c9a03019268595032007ae06',
    );
  });
});
