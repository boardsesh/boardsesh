/**
 * The statement text each per-board pull sends, per audience, written out in
 * full.
 *
 * The publication rule is short enough to read in the SQL: a published, listed
 * climb for everyone, plus the caller's own climbs. Nothing else may decide a
 * row, so a join, a lookup or a condition that appears in one of these
 * statements by accident shows up here as a diff a reviewer has to accept.
 * What the statements return is proven against a database in
 * `sync-publication-rule.test.ts`, and how they are planned in
 * `sync-audience-plan.test.ts`.
 *
 * To accept a deliberate change, re-run this file with `-u`.
 */
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { syncQueries } from '../graphql/resolvers/sync/queries';

const { database, transactionDatabase } = vi.hoisted(() => {
  const transactionDatabase = {
    execute: vi.fn((_statement: unknown): Promise<Array<Record<string, unknown>>> => Promise.resolve([])),
  };
  const database = {
    execute: vi.fn((_statement: unknown): Promise<Array<Record<string, unknown>>> => Promise.resolve([])),
    transaction: vi.fn((callback: (transactionDb: typeof transactionDatabase) => unknown) =>
      callback(transactionDatabase),
    ),
  };
  return { database, transactionDatabase };
});

vi.mock('../db/client', () => ({ db: database }));

const dialect = new PgDialect();
const VIEWER_ID = 'statement-viewer';

const viewerContext = {
  connectionId: 'sync-board-statements',
  isAuthenticated: true,
  userId: VIEWER_ID,
  sessionId: null,
  boardPath: null,
  controllerId: null,
  controllerApiKey: null,
} as unknown as ConnectionContext;

type Audience = 'REFERENCE' | 'PROTECTED' | undefined;
type Resolver = 'syncClimbs' | 'syncClimbStats' | 'syncClimbGrades';

/**
 * The page statement one request sends, with whitespace collapsed, and the
 * position of the caller's id among its parameters (0 when it is not sent).
 */
async function pageStatement(resolver: Resolver, audience: Audience): Promise<{ text: string; viewerParam: number }> {
  const args = { boardType: 'tension', layoutId: 10, sizeId: 6, cursor: null, limit: 500 };
  await syncQueries[resolver](undefined, audience === undefined ? args : { ...args, audience }, viewerContext);
  // The climbs page runs on the pool; the stats and grades pages run second on
  // the guarded transaction, after `SET LOCAL`.
  const statement = (
    resolver === 'syncClimbs' ? database.execute.mock.calls.at(-1)?.[0] : transactionDatabase.execute.mock.calls[1][0]
  ) as SQL;
  const { sql: text, params } = dialect.sqlToQuery(statement);
  return { text: text.replace(/\s+/g, ' ').trim(), viewerParam: params.indexOf(VIEWER_ID) + 1 };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('syncClimbs statements', () => {
  it('with no audience: published and listed, or the caller’s own', async () => {
    const { text, viewerParam } = await pageStatement('syncClimbs', undefined);
    expect(viewerParam).toBe(4);
    expect(text).toMatchInlineSnapshot(
      `"SELECT uuid, board_type, layout_id, setter_id, setter_username, name, description, hsm, edge_left, edge_right, edge_bottom, edge_top, angle, frames_count, frames_pace, frames, is_draft, is_listed, is_hidden, created_at, published_at, user_id, required_set_ids, compatible_size_ids, characteristics, hold_fingerprint, missing_hold_count, retired_by_reset, revision_number, holds_revision_number, updated_at, sync_seq, updated_at AS __updated_at, sync_seq AS __seq FROM board_climbs WHERE (board_type = $1 AND layout_id = $2 AND compatible_size_ids @> ARRAY[$3]::int[]) AND ((board_climbs.is_draft IS NOT TRUE AND board_climbs.is_listed IS TRUE) OR board_climbs.user_id = $4) AND (updated_at, sync_seq) > ($5::timestamp, $6::bigint) AND updated_at < now() - make_interval(secs => $7) ORDER BY updated_at ASC, sync_seq ASC LIMIT $8"`,
    );
  });

  it('REFERENCE: published and listed, with no caller in it', async () => {
    const { text, viewerParam } = await pageStatement('syncClimbs', 'REFERENCE');
    expect(viewerParam).toBe(0);
    expect(text).toMatchInlineSnapshot(
      `"SELECT uuid, board_type, layout_id, setter_id, setter_username, name, description, hsm, edge_left, edge_right, edge_bottom, edge_top, angle, frames_count, frames_pace, frames, is_draft, is_listed, is_hidden, created_at, published_at, user_id, required_set_ids, compatible_size_ids, characteristics, hold_fingerprint, missing_hold_count, retired_by_reset, revision_number, holds_revision_number, updated_at, sync_seq, updated_at AS __updated_at, sync_seq AS __seq FROM board_climbs WHERE (board_type = $1 AND layout_id = $2 AND compatible_size_ids @> ARRAY[$3]::int[]) AND (board_climbs.is_draft IS NOT TRUE AND board_climbs.is_listed IS TRUE) AND (updated_at, sync_seq) > ($4::timestamp, $5::bigint) AND updated_at < now() - make_interval(secs => $6) ORDER BY updated_at ASC, sync_seq ASC LIMIT $7"`,
    );
  });

  it('PROTECTED: the caller’s own climbs that are not published and listed', async () => {
    const { text, viewerParam } = await pageStatement('syncClimbs', 'PROTECTED');
    expect(viewerParam).toBe(4);
    expect(text).toMatchInlineSnapshot(
      `"SELECT uuid, board_type, layout_id, setter_id, setter_username, name, description, hsm, edge_left, edge_right, edge_bottom, edge_top, angle, frames_count, frames_pace, frames, is_draft, is_listed, is_hidden, created_at, published_at, user_id, required_set_ids, compatible_size_ids, characteristics, hold_fingerprint, missing_hold_count, retired_by_reset, revision_number, holds_revision_number, updated_at, sync_seq, updated_at AS __updated_at, sync_seq AS __seq FROM (SELECT * FROM board_climbs WHERE (board_type = $1 AND layout_id = $2 AND compatible_size_ids @> ARRAY[$3]::int[]) AND (board_climbs.user_id = $4 AND NOT (board_climbs.is_draft IS NOT TRUE AND board_climbs.is_listed IS TRUE)) OFFSET 0) board_climbs WHERE TRUE AND (updated_at, sync_seq) > ($5::timestamp, $6::bigint) AND updated_at < now() - make_interval(secs => $7) ORDER BY updated_at ASC, sync_seq ASC LIMIT $8"`,
    );
  });
});

describe('syncClimbStats statements', () => {
  it('with no audience', async () => {
    const { text, viewerParam } = await pageStatement('syncClimbStats', undefined);
    expect(viewerParam).toBe(5);
    expect(text).toMatchInlineSnapshot(
      `"SELECT board_type, climb_uuid, angle, display_difficulty, benchmark_difficulty, ascensionist_count, difficulty_average, quality_average, (SELECT board_climb_stats.fa_username FROM board_climbs fa_reference_climb WHERE fa_reference_climb.uuid = board_climb_stats.climb_uuid AND fa_reference_climb.board_type = board_climb_stats.board_type AND fa_reference_climb.user_id IS NULL AND NOT fa_reference_climb.is_boardsesh_authored) AS fa_username, (SELECT board_climb_stats.fa_at FROM board_climbs fa_reference_climb WHERE fa_reference_climb.uuid = board_climb_stats.climb_uuid AND fa_reference_climb.board_type = board_climb_stats.board_type AND fa_reference_climb.user_id IS NULL AND NOT fa_reference_climb.is_boardsesh_authored) AS fa_at, updated_at, sync_seq, board_climb_stats.updated_at AS __updated_at, board_climb_stats.sync_seq AS __seq FROM board_climb_stats WHERE board_type = $1 AND EXISTS (SELECT 1 FROM board_climbs bc WHERE bc.uuid = board_climb_stats.climb_uuid AND bc.board_type = $2 AND bc.layout_id = $3 AND bc.compatible_size_ids @> ARRAY[$4]::int[] AND ((bc.is_draft IS NOT TRUE AND bc.is_listed IS TRUE) OR bc.user_id = $5)) AND (board_climb_stats.updated_at, board_climb_stats.sync_seq) > ($6::timestamp, $7::bigint) AND board_climb_stats.updated_at < now() - make_interval(secs => $8) ORDER BY board_climb_stats.updated_at ASC, board_climb_stats.sync_seq ASC LIMIT $9"`,
    );
  });

  it('REFERENCE', async () => {
    const { text, viewerParam } = await pageStatement('syncClimbStats', 'REFERENCE');
    expect(viewerParam).toBe(0);
    expect(text).toMatchInlineSnapshot(
      `"SELECT board_type, climb_uuid, angle, display_difficulty, benchmark_difficulty, ascensionist_count, difficulty_average, quality_average, (SELECT board_climb_stats.fa_username FROM board_climbs fa_reference_climb WHERE fa_reference_climb.uuid = board_climb_stats.climb_uuid AND fa_reference_climb.board_type = board_climb_stats.board_type AND fa_reference_climb.user_id IS NULL AND NOT fa_reference_climb.is_boardsesh_authored) AS fa_username, (SELECT board_climb_stats.fa_at FROM board_climbs fa_reference_climb WHERE fa_reference_climb.uuid = board_climb_stats.climb_uuid AND fa_reference_climb.board_type = board_climb_stats.board_type AND fa_reference_climb.user_id IS NULL AND NOT fa_reference_climb.is_boardsesh_authored) AS fa_at, updated_at, sync_seq, board_climb_stats.updated_at AS __updated_at, board_climb_stats.sync_seq AS __seq FROM board_climb_stats WHERE board_type = $1 AND EXISTS (SELECT 1 FROM board_climbs bc WHERE bc.uuid = board_climb_stats.climb_uuid AND bc.board_type = $2 AND bc.layout_id = $3 AND bc.compatible_size_ids @> ARRAY[$4]::int[] AND (bc.is_draft IS NOT TRUE AND bc.is_listed IS TRUE)) AND (board_climb_stats.updated_at, board_climb_stats.sync_seq) > ($5::timestamp, $6::bigint) AND board_climb_stats.updated_at < now() - make_interval(secs => $7) ORDER BY board_climb_stats.updated_at ASC, board_climb_stats.sync_seq ASC LIMIT $8"`,
    );
  });

  it('PROTECTED', async () => {
    const { text, viewerParam } = await pageStatement('syncClimbStats', 'PROTECTED');
    expect(viewerParam).toBe(4);
    expect(text).toMatchInlineSnapshot(
      `"SELECT board_type, climb_uuid, angle, display_difficulty, benchmark_difficulty, ascensionist_count, difficulty_average, quality_average, NULL AS fa_username, NULL AS fa_at, updated_at, sync_seq, board_climb_stats.updated_at AS __updated_at, board_climb_stats.sync_seq AS __seq FROM (SELECT bc.uuid FROM board_climbs bc WHERE bc.board_type = $1 AND bc.layout_id = $2 AND bc.compatible_size_ids @> ARRAY[$3]::int[] AND (bc.user_id = $4 AND NOT (bc.is_draft IS NOT TRUE AND bc.is_listed IS TRUE)) OFFSET 0) own_climbs CROSS JOIN LATERAL ( SELECT own_ref.* FROM board_climb_stats own_ref WHERE own_ref.board_type = $5 AND own_ref.climb_uuid = own_climbs.uuid OFFSET 0 ) board_climb_stats WHERE TRUE AND (board_climb_stats.updated_at, board_climb_stats.sync_seq) > ($6::timestamp, $7::bigint) AND board_climb_stats.updated_at < now() - make_interval(secs => $8) ORDER BY board_climb_stats.updated_at ASC, board_climb_stats.sync_seq ASC LIMIT $9"`,
    );
  });
});

describe('syncClimbGrades statements', () => {
  it('with no audience', async () => {
    const { text, viewerParam } = await pageStatement('syncClimbGrades', undefined);
    expect(viewerParam).toBe(5);
    expect(text).toMatchInlineSnapshot(
      `"SELECT board_type, climb_uuid, angle, local_grade, universal_grade, grade_low, grade_high, confidence, ascensionist_count, computed_at, sync_seq, board_climb_grades.computed_at AS __updated_at, board_climb_grades.sync_seq AS __seq FROM board_climb_grades WHERE board_type = $1 AND EXISTS (SELECT 1 FROM board_climbs bc WHERE bc.uuid = board_climb_grades.climb_uuid AND bc.board_type = $2 AND bc.layout_id = $3 AND bc.compatible_size_ids @> ARRAY[$4]::int[] AND ((bc.is_draft IS NOT TRUE AND bc.is_listed IS TRUE) OR bc.user_id = $5)) AND (board_climb_grades.computed_at, board_climb_grades.sync_seq) > ($6::timestamp, $7::bigint) AND board_climb_grades.computed_at < now() - make_interval(secs => $8) ORDER BY board_climb_grades.computed_at ASC, board_climb_grades.sync_seq ASC LIMIT $9"`,
    );
  });

  it('REFERENCE', async () => {
    const { text, viewerParam } = await pageStatement('syncClimbGrades', 'REFERENCE');
    expect(viewerParam).toBe(0);
    expect(text).toMatchInlineSnapshot(
      `"SELECT board_type, climb_uuid, angle, local_grade, universal_grade, grade_low, grade_high, confidence, ascensionist_count, computed_at, sync_seq, board_climb_grades.computed_at AS __updated_at, board_climb_grades.sync_seq AS __seq FROM board_climb_grades WHERE board_type = $1 AND EXISTS (SELECT 1 FROM board_climbs bc WHERE bc.uuid = board_climb_grades.climb_uuid AND bc.board_type = $2 AND bc.layout_id = $3 AND bc.compatible_size_ids @> ARRAY[$4]::int[] AND (bc.is_draft IS NOT TRUE AND bc.is_listed IS TRUE)) AND (board_climb_grades.computed_at, board_climb_grades.sync_seq) > ($5::timestamp, $6::bigint) AND board_climb_grades.computed_at < now() - make_interval(secs => $7) ORDER BY board_climb_grades.computed_at ASC, board_climb_grades.sync_seq ASC LIMIT $8"`,
    );
  });

  it('PROTECTED', async () => {
    const { text, viewerParam } = await pageStatement('syncClimbGrades', 'PROTECTED');
    expect(viewerParam).toBe(4);
    expect(text).toMatchInlineSnapshot(
      `"SELECT board_type, climb_uuid, angle, local_grade, universal_grade, grade_low, grade_high, confidence, ascensionist_count, computed_at, sync_seq, board_climb_grades.computed_at AS __updated_at, board_climb_grades.sync_seq AS __seq FROM (SELECT bc.uuid FROM board_climbs bc WHERE bc.board_type = $1 AND bc.layout_id = $2 AND bc.compatible_size_ids @> ARRAY[$3]::int[] AND (bc.user_id = $4 AND NOT (bc.is_draft IS NOT TRUE AND bc.is_listed IS TRUE)) OFFSET 0) own_climbs CROSS JOIN LATERAL ( SELECT own_ref.* FROM board_climb_grades own_ref WHERE own_ref.board_type = $5 AND own_ref.climb_uuid = own_climbs.uuid OFFSET 0 ) board_climb_grades WHERE TRUE AND (board_climb_grades.computed_at, board_climb_grades.sync_seq) > ($6::timestamp, $7::bigint) AND board_climb_grades.computed_at < now() - make_interval(secs => $8) ORDER BY board_climb_grades.computed_at ASC, board_climb_grades.sync_seq ASC LIMIT $9"`,
    );
  });
});
