import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import { schemaSQL } from './schema-sql';

const UPDATE_TRIGGER_FUNCTIONS = ['public.set_board_climbs_sync_fields', 'public.set_board_climb_stats_sync_fields'];

const SNAPSHOT_FENCE_MIGRATION = readFileSync(
  new URL('../../../db/drizzle/0250_board_snapshot_replica_fence.sql', import.meta.url),
  'utf8',
);

function triggerSearchPath(sqlSource: string, functionName: string): string {
  const escapedFunctionName = functionName.replaceAll('.', '\\.');
  const definition = sqlSource.match(
    new RegExp(
      `CREATE OR REPLACE FUNCTION ${escapedFunctionName}\\(\\) RETURNS TRIGGER AS \\$\\$[\\s\\S]*?\\$\\$ LANGUAGE plpgsql SET search_path = ([^;]+);`,
    ),
  );
  if (!definition?.[1]) throw new Error(`Could not find trigger definition for ${functionName}`);
  return definition[1].trim();
}

describe('backend test trigger search paths', () => {
  for (const functionName of UPDATE_TRIGGER_FUNCTIONS) {
    it(`mirrors ${functionName} from migration 0250`, () => {
      const fixtureSearchPath = triggerSearchPath(schemaSQL, functionName);
      const migrationSearchPath = triggerSearchPath(SNAPSHOT_FENCE_MIGRATION, functionName);

      expect(fixtureSearchPath).toBe('public, pg_catalog');
      expect(fixtureSearchPath).toBe(migrationSearchPath);
    });
  }
});
