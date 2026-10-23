import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { SerialPlanDb } from '@boardsesh/db/queries';
import type { PlaylistClimbViewInput } from '@boardsesh/shared-schema';
import {
  allBoardsScope,
  buildPlaylistViewQueries,
  specificBoardScope,
} from '../graphql/resolvers/playlists/queries/playlist-climbs';
import { PlaylistClimbViewInputSchema } from '../validation/schemas';

/**
 * EXPLAIN plan-shape gate for a playlist view (#6651), in the style of
 * packages/db/src/queries/climbs/__tests__/search-climbs-explain.integration.test.ts.
 *
 * Opt-in: runs only when EXPLAIN_DB_URL points at a full-data dev DB (`vp run
 * db:up`, then the URL in .boardsesh/dev-db.env). Without it the suite skips, so
 * CI stays green. Never point it at the backend test DB: plans over near-empty
 * tables say nothing about production.
 *
 *   EXPLAIN_DB_URL=postgres://postgres:password@localhost:5432/main \
 *     vp test run --project backend packages/backend/src/__tests__/playlist-climbs-view-explain.test.ts
 *
 * It plans the EXACT queries the resolver runs (`buildPlaylistViewQueries`, over
 * the largest playlist in that DB) under the same serial-plan guard, on a
 * read-only connection, and asserts coarse invariants only: `board_climb_stats`
 * and `board_climb_grades` are reached by primary-key probes, never a scan or a
 * hash over the table, and no plan goes parallel. EXPLAIN_ANALYZE=1 logs timings.
 */
const EXPLAIN_DB_URL = process.env.EXPLAIN_DB_URL;
const RUN_ANALYZE = process.env.EXPLAIN_ANALYZE === '1';
const PROBED_TABLES = new Set(['board_climb_stats', 'board_climb_grades']);
const VIEWER = 'playlist-view-explain-viewer';

type PlanNode = { type: string; rel?: string; index?: string; ancestors: string[] };

function collectNodes(plan: Record<string, unknown>, ancestors: string[] = [], acc: PlanNode[] = []): PlanNode[] {
  const type = plan['Node Type'] as string;
  acc.push({
    type,
    rel: plan['Relation Name'] as string | undefined,
    index: plan['Index Name'] as string | undefined,
    ancestors,
  });
  for (const child of (plan['Plans'] as Record<string, unknown>[] | undefined) ?? []) {
    collectNodes(child, [...ancestors, type], acc);
  }
  return acc;
}

if (!EXPLAIN_DB_URL) {
  describe('playlist view EXPLAIN gate', () => {
    it.skip('skipped: set EXPLAIN_DB_URL to a full-data dev DB to run', () => {});
  });
} else {
  // Read-only, so nothing here can write to the database it plans against.
  const client = postgres(EXPLAIN_DB_URL, {
    prepare: false,
    max: 2,
    idle_timeout: 5,
    connection: { default_transaction_read_only: true },
  });
  const explainDb = drizzle(client) as unknown as SerialPlanDb;

  type PlaylistUnderTest = { id: string; boardType: string; layoutId: number; sizeId: number; climbs: number };
  let playlist: PlaylistUnderTest;

  async function explain(query: { toSQL(): { sql: string; params: unknown[] } }) {
    const { sql: text, params } = query.toSQL();
    const rows = await client.begin(async (tx) => {
      await tx.unsafe('SET LOCAL max_parallel_workers_per_gather = 0');
      const options = RUN_ANALYZE ? 'ANALYZE, BUFFERS, FORMAT JSON' : 'FORMAT JSON';
      return tx.unsafe(`EXPLAIN (${options}) ${text}`, params as never[]);
    });
    const [planWrapper] = rows[0]['QUERY PLAN'] as Array<{ Plan: Record<string, unknown>; 'Execution Time'?: number }>;
    return { nodes: collectNodes(planWrapper.Plan), executionMs: planWrapper['Execution Time'] };
  }

  describe('playlist view EXPLAIN gate', () => {
    beforeAll(async () => {
      const [largest] = await client<
        Array<{ id: string; board_type: string; layout_id: number; size_id: number | null; climbs: number }>
      >`
        SELECT p.id::text AS id, p.board_type, p.layout_id,
               (array_agg(c.compatible_size_ids[1]) FILTER (WHERE c.compatible_size_ids IS NOT NULL))[1] AS size_id,
               count(*)::int AS climbs
        FROM playlists p
        JOIN playlist_climbs pc ON pc.playlist_id = p.id
        JOIN board_climbs c ON c.uuid = pc.climb_uuid
        WHERE p.layout_id IS NOT NULL
        GROUP BY p.id
        ORDER BY count(*) DESC
        LIMIT 1
      `;
      expect(largest, 'the EXPLAIN DB has no playlist with climbs').toBeDefined();
      playlist = {
        id: largest.id,
        boardType: largest.board_type,
        layoutId: largest.layout_id,
        sizeId: largest.size_id ?? 0,
        climbs: largest.climbs,
      };
      console.info(
        `[playlist-view-explain] playlist ${playlist.id}: ${playlist.climbs} climbs on ${playlist.boardType}`,
      );
    });

    afterAll(async () => {
      await client.end();
    });

    const cases: Array<[string, 'all' | 'specific', PlaylistClimbViewInput, number]> = [
      ['difficulty sort, all boards', 'all', { sortBy: 'difficulty' }, 0],
      [
        'Boardsesh grade band + not sent + my grades, all boards, page 2',
        'all',
        {
          sortBy: 'difficulty',
          minGrade: 12,
          maxGrade: 20,
          gradeSource: 'BOARDSESH',
          hideCompleted: true,
          useMyGrades: true,
        },
        2,
      ],
      ['quality sort + fits my board, all boards', 'all', { sortBy: 'quality', onlyActiveBoard: true }, 0],
      ['random + grade floor, specific board', 'specific', { sortBy: 'random', sortSeed: '9', minGrade: 12 }, 0],
    ];

    for (const [label, mode, view, page] of cases) {
      it(`probes stats and grades by primary key: ${label}`, async () => {
        const playlistId = BigInt(playlist.id);
        const board = {
          boardName: playlist.boardType,
          layoutId: playlist.layoutId,
          sizeId: playlist.sizeId || undefined,
          angle: 40,
        };
        const scope =
          mode === 'specific'
            ? specificBoardScope(playlistId, board, VIEWER)
            : allBoardsScope(
                playlistId,
                {
                  activeBoardName: board.boardName,
                  activeAngle: board.angle,
                  activeLayoutId: board.layoutId,
                  activeSizeId: board.sizeId,
                },
                VIEWER,
              );
        const queries = buildPlaylistViewQueries(
          explainDb,
          scope,
          PlaylistClimbViewInputSchema.parse(view),
          page,
          20,
          VIEWER,
        );
        const planned = [
          queries.refQuery,
          queries.countQuery,
          ...(queries.unfilteredCountQuery ? [queries.unfilteredCountQuery] : []),
        ];
        for (const [index, query] of planned.entries()) {
          const { nodes, executionMs } = await explain(query);
          // Every case here sorts or filters on stats, so the list query must
          // actually reach both tables: an assertion over no nodes proves nothing.
          if (index === 0) {
            expect(
              new Set(nodes.flatMap((node) => (node.rel && PROBED_TABLES.has(node.rel) ? [node.rel] : []))),
            ).toEqual(PROBED_TABLES);
          }
          if (RUN_ANALYZE) console.info(`[playlist-view-explain] ${label}: ${executionMs?.toFixed(1)} ms`);
          for (const node of nodes) {
            expect(node.type, 'serial-plan guard').not.toMatch(/^Gather/);
            if (!node.rel || !PROBED_TABLES.has(node.rel)) continue;
            expect(['Index Scan', 'Index Only Scan'], `${node.rel} must be probed, not scanned`).toContain(node.type);
            // Primary key: `_pk` from drizzle migrations, `_pkey` from a plain CREATE TABLE.
            expect(node.index, `${node.rel} probe index`).toMatch(/_pk(ey)?$/);
            expect(node.ancestors, `${node.rel} must not feed a hash`).not.toContain('Hash');
          }
        }
      });
    }
  });
}
