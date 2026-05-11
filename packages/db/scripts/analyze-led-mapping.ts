/**
 * Analyze climbs for LED mapping compatibility issues.
 *
 * Two checks:
 * 1. "Filter bypass" — climbs where compatible_size_ids INCLUDES the size,
 *    but frames reference placement IDs with no LED mapping. These climbs
 *    PASS search filters and WILL cause BLE errors.
 *
 * 2. "Overall mismatch" — all climbs for a layout checked against each size.
 *    Expected for climbs designed for different sizes. Only interesting for context.
 *
 * Usage:
 *   bun run packages/db/scripts/analyze-led-mapping.ts [--board kilter] [--layout 1] [--size 10] [--limit 20] [--verbose]
 */

import { sql } from 'drizzle-orm';
import { createScriptDb } from './db-connection.js';
import { executeRows } from '../src/client/index.js';
import { LED_PLACEMENTS } from '../../board-constants/src/generated/led-placements-data.js';

type ClimbRow = {
  uuid: string;
  board_type: string;
  layout_id: number;
  name: string | null;
  setter_username: string | null;
  frames: string | null;
  is_listed: boolean | null;
  required_set_ids: number[] | null;
  compatible_size_ids: number[] | null;
  edge_left: number | null;
  edge_right: number | null;
  edge_bottom: number | null;
  edge_top: number | null;
};

type StatsRow = {
  climb_uuid: string;
  total_ascents: string;
};

type SetRow = {
  layout_id: number;
  product_size_id: number;
  set_id: number;
};

function parseFramePlacements(frames: string): number[] {
  const placements: number[] = [];
  const parts = frames.split('p').filter(Boolean);
  for (const part of parts) {
    const [holdStr] = part.split('r');
    const holdId = Number(holdStr);
    if (!Number.isNaN(holdId)) {
      placements.push(holdId);
    }
  }
  return placements;
}

// Parse CLI args
const args = process.argv.slice(2);
const boardFilter = args.includes('--board') ? args[args.indexOf('--board') + 1] : undefined;
const layoutFilter = args.includes('--layout') ? Number(args[args.indexOf('--layout') + 1]) : undefined;
const sizeFilter = args.includes('--size') ? Number(args[args.indexOf('--size') + 1]) : undefined;
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 20;
const verbose = args.includes('--verbose');

async function main() {
  const { db, close } = createScriptDb();

  try {
    const boardNames = boardFilter
      ? [boardFilter]
      : Object.keys(LED_PLACEMENTS).filter(
          (b) => Object.keys(LED_PLACEMENTS[b as keyof typeof LED_PLACEMENTS] || {}).length > 0,
        );

    // Get product sizes from DB for display
    const sizeRows = await executeRows<{ id: number; name: string }>(
      db,
      sql`
      SELECT id, name FROM board_product_sizes ORDER BY board_type, id
    `,
    );
    const sizeNames = new Map(sizeRows.map((s) => [s.id, s.name]));

    // Get set-to-layout-size mappings
    const setRows = await executeRows<SetRow>(
      db,
      sql`
      SELECT layout_id, product_size_id, set_id
      FROM board_product_sizes_layouts_sets
      ORDER BY layout_id, product_size_id, set_id
    `,
    );
    const setsForConfig = new Map<string, number[]>();
    for (const row of setRows) {
      const key = `${row.layout_id}-${row.product_size_id}`;
      const existing = setsForConfig.get(key) || [];
      existing.push(row.set_id);
      setsForConfig.set(key, existing);
    }

    let grandTotalFilterBypass = 0;
    let grandTotalNullDenorm = 0;
    let grandTotalMismatch = 0;

    for (const boardName of boardNames) {
      const boardLedData = LED_PLACEMENTS[boardName as keyof typeof LED_PLACEMENTS];
      if (!boardLedData) continue;

      const layoutSizeKeys = Object.keys(boardLedData);
      if (layoutSizeKeys.length === 0) continue;

      console.info(`\n${'='.repeat(70)}`);
      console.info(`  Board: ${boardName}`);
      console.info(`  LED layout/size combos: ${layoutSizeKeys.join(', ')}`);
      console.info(`${'='.repeat(70)}`);

      const layouts = [...new Set(layoutSizeKeys.map((k) => Number(k.split('-')[0])))];

      for (const layoutId of layouts) {
        if (layoutFilter !== undefined && layoutId !== layoutFilter) continue;

        const sizeKeys = layoutSizeKeys.filter((k) => k.startsWith(`${layoutId}-`)).map((k) => Number(k.split('-')[1]));

        // Fetch ALL climbs for this board/layout once (reused across sizes)
        const climbs = await executeRows<ClimbRow>(
          db,
          sql`
          SELECT uuid, board_type, layout_id, name, setter_username, frames,
                 is_listed, required_set_ids, compatible_size_ids,
                 edge_left, edge_right, edge_bottom, edge_top
          FROM board_climbs
          WHERE board_type = ${boardName}
            AND layout_id = ${layoutId}
            AND frames IS NOT NULL
            AND frames != ''
        `,
        );

        // Fetch ascensionist counts
        const statsRows = await executeRows<StatsRow>(
          db,
          sql`
          SELECT climb_uuid, COALESCE(SUM(ascensionist_count), 0) as total_ascents
          FROM board_climb_stats
          WHERE board_type = ${boardName}
          GROUP BY climb_uuid
        `,
        );
        const statsMap = new Map(statsRows.map((s) => [s.climb_uuid, Number(s.total_ascents)]));

        for (const sizeId of sizeKeys) {
          if (sizeFilter !== undefined && sizeId !== sizeFilter) continue;

          const ledMap = boardLedData[`${layoutId}-${sizeId}`];
          const ledPlacementIds = new Set(Object.keys(ledMap).map(Number));
          const availableSets = setsForConfig.get(`${layoutId}-${sizeId}`) || [];

          console.info(`\n--- ${boardName} layout=${layoutId} size=${sizeId} (${sizeNames.get(sizeId) || '?'}) ---`);
          console.info(`    LED placements: ${ledPlacementIds.size}`);
          console.info(`    Available sets: [${availableSets.join(', ')}]`);
          console.info(`    Total climbs for layout: ${climbs.length.toLocaleString()}`);

          type AffectedClimb = {
            climb: ClimbRow;
            missingPlacementIds: number[];
            totalPlacements: number;
            ascents: number;
            category: 'filter_bypass' | 'null_denorm' | 'correctly_excluded';
          };

          const filterBypass: AffectedClimb[] = [];
          const nullDenorm: AffectedClimb[] = [];
          let correctlyExcluded = 0;

          for (const climb of climbs) {
            const framePlacements = parseFramePlacements(climb.frames!);
            if (framePlacements.length === 0) continue;

            const missingPlacementIds = [...new Set(framePlacements.filter((id) => !ledPlacementIds.has(id)))];
            if (missingPlacementIds.length === 0) continue;

            const ascents = statsMap.get(climb.uuid) ?? 0;

            // Critical check: does the climb claim to be compatible with this size?
            const claimsSizeCompat = climb.compatible_size_ids !== null && climb.compatible_size_ids.includes(sizeId);

            // Is denormalized data missing?
            // In PostgreSQL, NULL <@ ARRAY[...] returns NULL (not TRUE), so these rows
            // are excluded from search results. Treat them as "null denorm", not bypass.
            const hasMissingDenorm = climb.compatible_size_ids === null || climb.required_set_ids === null;

            // Does the climb pass the set filter for this config?
            // Only true when required_set_ids is non-null AND all sets are available.
            const passesSetFilter =
              climb.required_set_ids !== null && climb.required_set_ids.every((setId) => availableSets.includes(setId));

            if (hasMissingDenorm) {
              // NULL denormalized columns — PostgreSQL excludes these from search
              nullDenorm.push({
                climb,
                missingPlacementIds,
                totalPlacements: framePlacements.length,
                ascents,
                category: 'null_denorm',
              });
            } else if (claimsSizeCompat && passesSetFilter) {
              // This climb PASSES the search filter but has bad LED mappings!
              filterBypass.push({
                climb,
                missingPlacementIds,
                totalPlacements: framePlacements.length,
                ascents,
                category: 'filter_bypass',
              });
            } else {
              correctlyExcluded++;
            }
          }

          grandTotalFilterBypass += filterBypass.length;
          grandTotalNullDenorm += nullDenorm.length;
          grandTotalMismatch += correctlyExcluded;

          console.info(
            `\n    FILTER BYPASS (passes search filters, breaks BLE): ${filterBypass.length.toLocaleString()}`,
          );
          console.info(`    NULL denormalized columns: ${nullDenorm.length.toLocaleString()}`);
          console.info(`    Correctly excluded by search filters: ${correctlyExcluded.toLocaleString()}`);

          // Show filter bypass climbs — these are the critical bugs
          if (filterBypass.length > 0) {
            filterBypass.sort((a, b) => b.ascents - a.ascents);
            const topN = filterBypass.slice(0, limit);
            console.info(`\n    ** CRITICAL: ${filterBypass.length} climbs pass filters but break BLE **\n`);

            for (const entry of topN) {
              const { climb, missingPlacementIds, totalPlacements, ascents } = entry;
              const listedTag = climb.is_listed === false ? ' [unlisted]' : '';
              console.info(
                `      "${climb.name || '(unnamed)'}" by ${climb.setter_username || '?'}` +
                  ` — ${ascents.toLocaleString()} ascents${listedTag}`,
              );
              console.info(
                `        ${missingPlacementIds.length} of ${totalPlacements} placements missing LED mapping`,
              );
              console.info(
                `        Missing IDs: [${missingPlacementIds.slice(0, 10).join(', ')}${missingPlacementIds.length > 10 ? `, ... (${missingPlacementIds.length} total)` : ''}]`,
              );
              console.info(`        compatible_size_ids: [${climb.compatible_size_ids?.join(', ')}]`);
              console.info(`        required_set_ids: [${climb.required_set_ids?.join(', ')}]`);
              if (verbose) {
                console.info(`        uuid: ${climb.uuid}`);
                console.info(
                  `        frames: ${climb.frames?.slice(0, 80)}${(climb.frames?.length ?? 0) > 80 ? '...' : ''}`,
                );
              }
            }

            // Show the unique missing placement IDs
            const allMissing = new Set<number>();
            for (const { missingPlacementIds } of filterBypass) {
              for (const id of missingPlacementIds) allMissing.add(id);
            }
            console.info(`\n    Missing placement IDs in filter-bypassing climbs: ${allMissing.size}`);
            console.info(
              `    IDs: [${[...allMissing]
                .sort((a, b) => a - b)
                .slice(0, 30)
                .join(', ')}${allMissing.size > 30 ? '...' : ''}]`,
            );
          }

          // Show null denorm climbs (potential issue if accessed directly)
          if (nullDenorm.length > 0) {
            nullDenorm.sort((a, b) => b.ascents - a.ascents);
            const topN = nullDenorm.slice(0, Math.min(5, limit));
            console.info(`\n    NULL denorm climbs (excluded from search, but fragile):\n`);
            for (const entry of topN) {
              const { climb, missingPlacementIds, totalPlacements, ascents } = entry;
              console.info(
                `      "${climb.name || '(unnamed)'}" — ${ascents.toLocaleString()} ascents` +
                  ` | compatible_size_ids: ${climb.compatible_size_ids ?? 'NULL'}` +
                  ` | required_set_ids: ${climb.required_set_ids ?? 'NULL'}` +
                  ` | ${missingPlacementIds.length}/${totalPlacements} missing`,
              );
            }
          }
        }
      }

      // Cross-layout: check for climbs with layout IDs that have no LED data
      console.info(`\n--- ${boardName}: Layouts without LED data ---`);
      const ledLayoutIds = [...new Set(Object.keys(boardLedData).map((k) => Number(k.split('-')[0])))];

      const unmappedLayoutRows = await executeRows<{ layout_id: number; climb_count: string; listed_count: string }>(
        db,
        sql`
        SELECT layout_id, COUNT(*) as climb_count,
               COUNT(*) FILTER (WHERE is_listed = true) as listed_count
        FROM board_climbs
        WHERE board_type = ${boardName}
          AND frames IS NOT NULL
          AND layout_id IS NOT NULL
        GROUP BY layout_id
        ORDER BY layout_id
      `,
      );

      let anyUnmapped = false;
      for (const row of unmappedLayoutRows) {
        if (!ledLayoutIds.includes(row.layout_id)) {
          console.info(
            `    Layout ${row.layout_id}: ${Number(row.climb_count).toLocaleString()} climbs (${Number(row.listed_count).toLocaleString()} listed) — NO LED DATA`,
          );
          anyUnmapped = true;
        }
      }
      if (!anyUnmapped) console.info(`    All layouts have LED data ✓`);
    }

    // Grand summary
    console.info(`\n${'='.repeat(70)}`);
    console.info('  SUMMARY');
    console.info(`${'='.repeat(70)}`);
    console.info(`  CRITICAL — pass search filters, break BLE: ${grandTotalFilterBypass.toLocaleString()}`);
    console.info(`  NULL denormalized columns: ${grandTotalNullDenorm.toLocaleString()}`);
    console.info(`  Correctly excluded by filters: ${grandTotalMismatch.toLocaleString()}`);
    if (grandTotalFilterBypass > 0) {
      console.info(`\n  ⚠ ${grandTotalFilterBypass} climbs will appear in search results and cause BLE errors!`);
    }
    if (grandTotalFilterBypass === 0 && grandTotalNullDenorm === 0) {
      console.info(`\n  Search filters correctly exclude all affected climbs.`);
      console.info(`  If users still hit BLE errors, climbs are reaching BLE through non-search paths`);
      console.info(`  (queue from different config, shared links, suggestions, etc.)`);
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
