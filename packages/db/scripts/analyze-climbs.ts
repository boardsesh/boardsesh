/**
 * Analyze the climbs database for problematic frame strings.
 *
 * Checks:
 * 1. Unknown role codes — role IDs not in the HOLD_STATE_MAP for the board
 * 2. Missing starting holds — climbs with no STARTING role in their frames
 * 3. Missing finish holds — climbs with no FINISH role in their frames
 * 4. Empty or malformed frames — frames that don't match the expected pattern
 * 5. Negative role codes — unexpected negative values
 *
 * Usage:
 *   bun run packages/db/scripts/analyze-climbs.ts [--board kilter] [--limit 20] [--verbose]
 */

import { sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { executeRows } from '../src/client/index.js';

// Simplified local copy of HOLD_STATE_MAP (role code → role name only, no colors).
// The canonical version lives in @boardsesh/board-constants/hold-states but the db
// package intentionally does not depend on board-constants. Keep in sync manually.
const HOLD_STATE_MAP: Record<string, Record<number, string>> = {
  kilter: {
    12: 'STARTING',
    13: 'HAND',
    14: 'FINISH',
    15: 'FOOT',
    20: 'STARTING',
    21: 'HAND',
    22: 'FINISH',
    23: 'FOOT',
    24: 'STARTING',
    25: 'HAND',
    26: 'FINISH',
    27: 'FOOT',
    28: 'STARTING',
    29: 'HAND',
    30: 'FINISH',
    31: 'FOOT',
    32: 'STARTING',
    33: 'HAND',
    34: 'FINISH',
    35: 'FOOT',
    36: 'HAND',
    37: 'HAND',
    38: 'HAND',
    39: 'HAND',
    40: 'HAND',
    41: 'HAND',
    42: 'STARTING',
    43: 'HAND',
    44: 'FINISH',
    45: 'FOOT',
  },
  tension: {
    1: 'STARTING',
    2: 'HAND',
    3: 'FINISH',
    4: 'FOOT',
    5: 'STARTING',
    6: 'HAND',
    7: 'FINISH',
    8: 'FOOT',
  },
  moonboard: {
    42: 'STARTING',
    43: 'HAND',
    44: 'FINISH',
  },
  decoy: {
    1: 'STARTING',
    2: 'HAND',
    3: 'FINISH',
    4: 'FOOT',
  },
  touchstone: {
    1: 'STARTING',
    2: 'HAND',
    3: 'FINISH',
    4: 'FOOT',
  },
  grasshopper: {
    1: 'STARTING',
    2: 'HAND',
    3: 'FINISH',
    4: 'FOOT',
  },
};

// Role codes that count as STARTING per board
const STARTING_ROLES: Record<string, Set<number>> = {};
const FINISH_ROLES: Record<string, Set<number>> = {};
for (const [board, roles] of Object.entries(HOLD_STATE_MAP)) {
  STARTING_ROLES[board] = new Set(
    Object.entries(roles)
      .filter(([, name]) => name === 'STARTING')
      .map(([code]) => Number(code)),
  );
  FINISH_ROLES[board] = new Set(
    Object.entries(roles)
      .filter(([, name]) => name === 'FINISH')
      .map(([code]) => Number(code)),
  );
}

type ClimbRow = {
  uuid: string;
  board_type: string;
  name: string | null;
  setter_username: string | null;
  frames: string | null;
  is_listed: boolean | null;
};

type StatsRow = {
  climb_uuid: string;
  total_ascents: string;
};

function parseFrames(frames: string): Array<{ holdId: number; roleCode: number }> {
  const holds: Array<{ holdId: number; roleCode: number }> = [];
  const parts = frames.split('p').filter(Boolean);
  for (const part of parts) {
    const [holdStr, roleStr] = part.split('r');
    const holdId = Number(holdStr);
    const roleCode = Number(roleStr);
    if (!Number.isNaN(holdId) && !Number.isNaN(roleCode)) {
      holds.push({ holdId, roleCode });
    }
  }
  return holds;
}

type Problem = {
  type: 'unknown_role' | 'no_starting' | 'no_finish' | 'empty_frames' | 'malformed_frames' | 'negative_role';
  detail: string;
};

function analyzeClimb(climb: ClimbRow): Problem[] {
  const problems: Problem[] = [];
  const { frames, board_type } = climb;
  const boardMap = HOLD_STATE_MAP[board_type];

  if (!frames || frames.trim() === '') {
    problems.push({ type: 'empty_frames', detail: 'frames string is empty or null' });
    return problems;
  }

  // Check basic format
  if (!/^p\d+r-?\d+/.test(frames)) {
    problems.push({
      type: 'malformed_frames',
      detail: `frames doesn't start with expected pattern: "${frames.slice(0, 40)}..."`,
    });
    return problems;
  }

  const holds = parseFrames(frames);
  if (holds.length === 0) {
    problems.push({ type: 'malformed_frames', detail: 'no holds could be parsed from frames' });
    return problems;
  }

  // Check for unknown role codes
  const unknownRoles = new Set<number>();
  for (const { roleCode } of holds) {
    if (roleCode < 0) {
      problems.push({ type: 'negative_role', detail: `negative role code: ${roleCode}` });
    }
    if (boardMap && !(roleCode in boardMap)) {
      unknownRoles.add(roleCode);
    }
  }
  if (unknownRoles.size > 0) {
    problems.push({
      type: 'unknown_role',
      detail: `unknown role codes for ${board_type}: [${[...unknownRoles].sort((a, b) => a - b).join(', ')}]`,
    });
  }

  // Check for missing starting holds (skip Tycho/color-mode climbs that don't use start/finish)
  const startingRoles = STARTING_ROLES[board_type];
  const finishRoles = FINISH_ROLES[board_type];

  if (startingRoles && startingRoles.size > 0) {
    const hasStart = holds.some(({ roleCode }) => startingRoles.has(roleCode));
    if (!hasStart) {
      problems.push({ type: 'no_starting', detail: 'no holds with a STARTING role' });
    }
  }

  if (finishRoles && finishRoles.size > 0) {
    const hasFinish = holds.some(({ roleCode }) => finishRoles.has(roleCode));
    if (!hasFinish) {
      problems.push({ type: 'no_finish', detail: 'no holds with a FINISH role' });
    }
  }

  return problems;
}

// Parse CLI args
const args = process.argv.slice(2);
const boardFilter = args.includes('--board') ? args[args.indexOf('--board') + 1] : undefined;
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 20;
const verbose = args.includes('--verbose');

async function main() {
  const { db, close } = createScriptDb();

  try {
    // First, check for any role codes in the DB that aren't in our map
    console.info('=== Checking for unmapped role codes in board_placement_roles ===\n');

    const dbRoles = await executeRows<{
      board_type: string;
      id: number;
      name: string;
      full_name: string;
      product_id: number;
    }>(
      db,
      sql`
      SELECT board_type, id, name, full_name, product_id
      FROM board_placement_roles
      ORDER BY board_type, id
    `,
    );

    let unmappedCount = 0;
    for (const role of dbRoles) {
      const boardMap = HOLD_STATE_MAP[role.board_type];
      if (boardMap && !(role.id in boardMap)) {
        console.info(`  UNMAPPED: ${role.board_type} role ${role.id} "${role.full_name}" (product ${role.product_id})`);
        unmappedCount++;
      }
    }
    if (unmappedCount === 0) {
      console.info('  All placement roles are mapped in HOLD_STATE_MAP ✓');
    } else {
      console.info(`\n  ${unmappedCount} unmapped role(s) found — these will cause rendering issues`);
    }

    // Now scan climbs
    const boards = boardFilter ? [boardFilter] : Object.keys(HOLD_STATE_MAP);

    for (const board of boards) {
      console.info(`\n=== Analyzing ${board} climbs ===\n`);

      const climbs = await executeRows<ClimbRow>(
        db,
        sql`
        SELECT uuid, board_type, name, setter_username, frames, is_listed
        FROM board_climbs
        WHERE board_type = ${board}
      `,
      );

      // Gather ascensionist counts for affected climbs
      const statsRows = await executeRows<StatsRow>(
        db,
        sql`
        SELECT climb_uuid, COALESCE(SUM(ascensionist_count), 0) as total_ascents
        FROM board_climb_stats
        WHERE board_type = ${board}
        GROUP BY climb_uuid
      `,
      );

      const statsMap = new Map(statsRows.map((s) => [s.climb_uuid, Number(s.total_ascents)]));

      const problemCounts: Record<string, number> = {
        unknown_role: 0,
        no_starting: 0,
        no_finish: 0,
        empty_frames: 0,
        malformed_frames: 0,
        negative_role: 0,
      };
      const problemClimbs: Array<{ climb: ClimbRow; problems: Problem[]; ascents: number }> = [];

      for (const climb of climbs) {
        const problems = analyzeClimb(climb);
        if (problems.length > 0) {
          for (const p of problems) {
            problemCounts[p.type]++;
          }
          problemClimbs.push({
            climb,
            problems,
            ascents: statsMap.get(climb.uuid) ?? 0,
          });
        }
      }

      const totalProblematic = problemClimbs.length;
      console.info(`  Total climbs: ${climbs.length.toLocaleString()}`);
      console.info(
        `  Problematic:  ${totalProblematic.toLocaleString()} (${climbs.length > 0 ? ((totalProblematic / climbs.length) * 100).toFixed(2) : '0.00'}%)`,
      );
      console.info('');
      console.info('  Breakdown:');
      for (const [type, count] of Object.entries(problemCounts)) {
        if (count > 0) {
          console.info(`    ${type}: ${count.toLocaleString()}`);
        }
      }

      if (totalProblematic > 0) {
        // Sort by ascensionist count descending, show top N
        problemClimbs.sort((a, b) => b.ascents - a.ascents);
        const topN = problemClimbs.slice(0, limit);

        console.info(
          `\n  Top ${Math.min(limit, totalProblematic)} affected climbs (by total ascents across all angles):\n`,
        );
        for (const { climb, problems, ascents } of topN) {
          console.info(
            `    "${climb.name || '(unnamed)'}" by ${climb.setter_username || '?'} — ${ascents.toLocaleString()} ascents ${climb.is_listed === false ? '[unlisted]' : ''}`,
          );
          for (const p of problems) {
            console.info(`      → ${p.type}: ${p.detail}`);
          }
          if (verbose) {
            console.info(`      frames: ${climb.frames?.slice(0, 80)}${(climb.frames?.length ?? 0) > 80 ? '...' : ''}`);
          }
        }
      }
    }

    // Summary of all unknown role codes across all climbs
    console.info('\n=== Unknown role codes summary ===\n');
    const allUnknown = await executeRows<{ board_type: string; role_code: number; climb_count: string }>(
      db,
      sql`
      SELECT board_type,
        (regexp_matches(frames, 'r(-?\d+)', 'g'))[1]::int as role_code,
        count(*) as climb_count
      FROM board_climbs
      WHERE frames IS NOT NULL AND frames != ''
      GROUP BY board_type, role_code
      ORDER BY board_type, role_code
    `,
    );

    let anyUnknown = false;
    for (const row of allUnknown) {
      const boardMap = HOLD_STATE_MAP[row.board_type];
      if (boardMap && !(row.role_code in boardMap)) {
        console.info(`  ${row.board_type} role ${row.role_code}: ${Number(row.climb_count).toLocaleString()} climbs`);
        anyUnknown = true;
      }
    }
    if (!anyUnknown) {
      console.info('  No unknown role codes found ✓');
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
