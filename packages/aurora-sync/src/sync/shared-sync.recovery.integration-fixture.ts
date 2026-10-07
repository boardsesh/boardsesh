import type postgres from 'postgres';

type FixtureClient = ReturnType<typeof postgres>;

/**
 * Create only the Aurora writer tables needed by the #4161 acceptance test.
 * The caller must first verify the dedicated database identity. This is test
 * fixture DDL, not a repository migration or production repair operation.
 */
export async function initializeAuroraRecoveryFixture(client: FixtureClient): Promise<void> {
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS board_shared_syncs (
      board_type text NOT NULL,
      table_name text NOT NULL,
      last_synchronized_at text,
      PRIMARY KEY (board_type, table_name)
    )
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS board_climbs (
      uuid text PRIMARY KEY NOT NULL,
      board_type text NOT NULL,
      layout_id integer NOT NULL,
      setter_id integer,
      setter_username text,
      name text,
      description text DEFAULT '',
      hsm integer,
      edge_left integer,
      edge_right integer,
      edge_bottom integer,
      edge_top integer,
      angle integer,
      frames_count integer DEFAULT 1,
      frames_pace integer DEFAULT 0,
      frames text,
      is_draft boolean DEFAULT false,
      is_listed boolean,
      is_hidden boolean NOT NULL DEFAULT false,
      hidden_at timestamp,
      published_at text,
      synced boolean NOT NULL DEFAULT true,
      sync_error text,
      -- The real table references users; this narrow writer fixture only
      -- exercises the ownership predicate and deliberately has no users table.
      user_id text,
      created_at text,
      required_set_ids integer[],
      compatible_size_ids integer[],
      hold_fingerprint text,
      characteristics text[],
      missing_hold_count integer,
      updated_at timestamp NOT NULL DEFAULT now(),
      sync_seq bigserial NOT NULL
    )
  `);

  // The guarded first attempt may already have created the narrow fixture
  // table before the writer revealed the rest of Drizzle's insert column set.
  // These additive clauses align that same disposable fixture with the full
  // insert shape without dropping or resetting any test data.
  await client.unsafe(`
    ALTER TABLE board_climbs
      ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS hidden_at timestamp,
      ADD COLUMN IF NOT EXISTS published_at text,
      ADD COLUMN IF NOT EXISTS synced boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS sync_error text,
      ADD COLUMN IF NOT EXISTS compatible_size_ids integer[],
      ADD COLUMN IF NOT EXISTS hold_fingerprint text,
      ADD COLUMN IF NOT EXISTS missing_hold_count integer,
      ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS sync_seq bigserial NOT NULL
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS board_climb_holds (
      board_type text NOT NULL,
      climb_uuid text NOT NULL REFERENCES board_climbs(uuid) ON DELETE CASCADE,
      hold_id integer NOT NULL,
      frame_number integer NOT NULL,
      hold_state text NOT NULL,
      created_at timestamp DEFAULT now(),
      PRIMARY KEY (board_type, climb_uuid, hold_id)
    )
  `);

  await client.unsafe(`
    ALTER TABLE board_climb_holds
      ADD COLUMN IF NOT EXISTS created_at timestamp DEFAULT now()
  `);
}
