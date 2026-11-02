import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SerialPlanDb } from '@boardsesh/db/queries';
import type { PlaylistClimbViewInput } from '@boardsesh/shared-schema';
import { allBoardsScope, specificBoardScope } from '../graphql/resolvers/playlists/queries/playlist-climbs';
import {
  logbookViewSource,
  smartPlaylistCountsSql,
  type LogbookPlaylistType,
} from '../graphql/resolvers/playlists/queries/smart-playlists';
import {
  buildPlaylistViewQueries,
  type PlaylistViewSource,
} from '../graphql/resolvers/playlists/helpers/playlist-view';
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
 *
 * The smart playlists' logbook views run through the same builder and get the
 * same gate, over the heaviest logbook in the DB (the heaviest favouriter's for
 * LIKED_CLIMBS), with its first Kilter or Tension board as the active board.
 * The page query carries its match count as `count(*) OVER ()`, so the gate
 * also checks the window is there and the probes stay probes beneath it.
 *
 * The library cards' counts query (`smartPlaylistCountsSql`, #6808) is planned
 * over the same heaviest logbook: every tick's climb, alias and spray checks
 * must reach `board_climbs`, `board_climb_aliases` and the ticks by index,
 * never a sequential scan, and serially.
 *
 * Plan with `jit = off`, as production runs (docs/postgres-dr-architecture.md):
 * with JIT on, compiling these plans takes longer than running them.
 */
const EXPLAIN_DB_URL = process.env.EXPLAIN_DB_URL;
const RUN_ANALYZE = process.env.EXPLAIN_ANALYZE === '1';
const PROBED_TABLES = new Set(['board_climb_stats', 'board_climb_grades']);
// The tables the library cards' query reaches once per tick (#6808).
const CARD_INDEXED_TABLES = new Set(['boardsesh_ticks', 'board_climbs', 'board_climb_aliases']);
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
      await tx.unsafe('SET LOCAL jit = off');
      const options = RUN_ANALYZE ? 'ANALYZE, BUFFERS, FORMAT JSON' : 'FORMAT JSON';
      return tx.unsafe(`EXPLAIN (${options}) ${text}`, params as never[]);
    });
    const [planWrapper] = rows[0]['QUERY PLAN'] as Array<{ Plan: Record<string, unknown>; 'Execution Time'?: number }>;
    return { nodes: collectNodes(planWrapper.Plan), executionMs: planWrapper['Execution Time'] };
  }

  // Both suites below share the one read-only client.
  afterAll(async () => {
    await client.end();
  });

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
        await assertViewPlans(queries, label);
      });
    }
  });

  describe('smart playlist view EXPLAIN gate', () => {
    let logbookUserId: string;
    let favouriterUserId: string;
    let activeBoard: { boardType: string; layoutId: number; sizeId: number; angle: number };

    beforeAll(async () => {
      const [heaviest] = await client<Array<{ user_id: string; ticks: number }>>`
        SELECT user_id, count(*)::int AS ticks FROM boardsesh_ticks GROUP BY user_id ORDER BY count(*) DESC LIMIT 1
      `;
      expect(heaviest, 'the EXPLAIN DB has no ticks').toBeDefined();
      logbookUserId = heaviest.user_id;
      const [favouriter] = await client<Array<{ user_id: string; likes: number }>>`
        SELECT user_id, count(*)::int AS likes FROM user_favorites GROUP BY user_id ORDER BY count(*) DESC LIMIT 1
      `;
      // A DB with no hearts at all still plans the LIKED_CLIMBS shape, over nobody's likes.
      favouriterUserId = favouriter?.user_id ?? logbookUserId;
      console.info(
        `[playlist-view-explain] likes: ${favouriter ? `${favouriter.likes} by ${favouriter.user_id}` : 'none'}`,
      );
      const [board] = await client<Array<{ board_type: string; layout_id: number; size_id: number; angle: number }>>`
        SELECT board_type, layout_id::int, size_id::int, angle::int FROM user_boards
        WHERE deleted_at IS NULL AND board_type IN ('kilter', 'tension')
        ORDER BY id LIMIT 1
      `;
      expect(board, 'the EXPLAIN DB has no Kilter or Tension board').toBeDefined();
      activeBoard = {
        boardType: board.board_type,
        layoutId: board.layout_id,
        sizeId: board.size_id,
        angle: board.angle,
      };
      console.info(
        `[playlist-view-explain] logbook ${logbookUserId} (${heaviest.ticks} ticks) on ${activeBoard.boardType} ${activeBoard.layoutId}/${activeBoard.sizeId} at ${activeBoard.angle}°`,
      );
    });

    const logbookCases: Array<[LogbookPlaylistType, PlaylistClimbViewInput]> = [
      ['MOST_REPEATED', { sortBy: 'difficulty' }],
      ['PROJECTS', { minGrade: 12, maxGrade: 20, gradeSource: 'BOARDSESH', hideCompleted: true }],
      ['LIKED_CLIMBS', { sortBy: 'quality', onlyActiveBoard: true }],
      ['FIVE_STARS', { sortBy: 'random', sortSeed: '9', minGrade: 12 }],
    ];
    for (const [type, view] of logbookCases) {
      const label = `${type} ${JSON.stringify(view)}`;
      it(`probes stats and grades by primary key: ${label}`, async () => {
        const userId = type === 'LIKED_CLIMBS' ? favouriterUserId : logbookUserId;
        const source = logbookViewSource(
          type,
          {
            userId,
            activeBoardName: activeBoard.boardType,
            activeAngle: activeBoard.angle,
            activeLayoutId: activeBoard.layoutId,
            activeSizeId: activeBoard.sizeId,
          },
          userId,
        );
        await assertViewPlans(viewQueries(source, view, userId), label);
      });
    }
    it('plans the library cards’ counts by index, never a scan, serially (#6808)', async () => {
      const cardSql = smartPlaylistCountsSql(logbookUserId);
      const { nodes, executionMs } = await explain({ toSQL: () => new PgDialect().sqlToQuery(cardSql) });
      if (RUN_ANALYZE) console.info(`[playlist-view-explain] library cards: ${executionMs?.toFixed(1)} ms`);
      // The plan must reach every one of them, or the loop below proves nothing.
      expect(
        new Set(nodes.flatMap((node) => (node.rel && CARD_INDEXED_TABLES.has(node.rel) ? [node.rel] : []))),
      ).toEqual(CARD_INDEXED_TABLES);
      for (const node of nodes) {
        expect(node.type, 'serial-plan guard').not.toMatch(/^Gather/);
        if (!node.rel || !CARD_INDEXED_TABLES.has(node.rel)) continue;
        expect(node.type, `${node.rel} must be reached by index`).not.toBe('Seq Scan');
      }
    });
  });

  function viewQueries(source: PlaylistViewSource, view: PlaylistClimbViewInput, viewer: string) {
    return buildPlaylistViewQueries(explainDb, source, PlaylistClimbViewInputSchema.parse(view), 0, 20, viewer);
  }

  /**
   * Plan every query of a view page and check the invariants: no parallel plan,
   * and every stats or grades node is a primary-key probe that feeds no hash.
   */
  async function assertViewPlans(queries: ReturnType<typeof buildPlaylistViewQueries>, label: string) {
    const planned = [
      queries.refQuery,
      queries.countQuery,
      ...(queries.unfilteredCountQuery ? [queries.unfilteredCountQuery] : []),
    ];
    for (const [index, query] of planned.entries()) {
      const { nodes, executionMs } = await explain(query);
      // Every case sorts or filters on stats, so the list query must actually
      // reach both tables: an assertion over no nodes proves nothing.
      if (index === 0) {
        expect(new Set(nodes.flatMap((node) => (node.rel && PROBED_TABLES.has(node.rel) ? [node.rel] : [])))).toEqual(
          PROBED_TABLES,
        );
        // The page carries its own match count.
        expect(nodes.map((node) => node.type)).toContain('WindowAgg');
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
  }
}
