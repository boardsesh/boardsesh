import { describe, expect, it } from 'vite-plus/test';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { QUANTUM_RELEASED_LAYOUT_IDS } from '@boardsesh/board-constants/quantum';
import { rowsFromResult } from '@boardsesh/db/client';
import { boardClimbs } from '@boardsesh/db/schema';
import {
  hidesWithdrawnClimbsBoardCondition,
  quantumCatalogClimbCondition,
  unavailableCatalogClimbBoardCondition,
  unavailableCatalogClimbCondition,
  withdrawnCatalogClimbCondition,
} from '@boardsesh/db/queries';
import { db } from '../db/client';
import { snapshotCatalogEligibility } from '../scripts/catalog-snapshot-eligibility';

// The Quantum-named helpers the board-agnostic predicates replaced, copied
// verbatim from packages/db/src/queries/climbs/quantum-catalog-ownership.ts and
// packages/backend/src/scripts/quantum-snapshot-eligibility.ts at 11ae71c064.
// Every assertion below compares the new SQL with these, never with a literal.

function legacyQuantumCatalogClimbCondition(
  climb: {
    boardType: SQLWrapper;
    userId: SQLWrapper;
    isBoardseshAuthored: SQLWrapper;
    controllerRouteUuid: SQLWrapper;
  } = boardClimbs,
): SQL {
  return sql`(${climb.boardType} = 'quantum' AND ${climb.userId} IS NULL
    AND ${climb.isBoardseshAuthored} IS FALSE AND ${climb.controllerRouteUuid} IS NOT NULL)`;
}

function legacyRetiredQuantumCatalogClimbCondition(prefix: SQL = sql`board_climbs.`): SQL {
  return sql`(${prefix}is_listed IS NOT TRUE AND ${legacyQuantumCatalogClimbCondition({
    boardType: sql`${prefix}board_type`,
    userId: sql`${prefix}user_id`,
    isBoardseshAuthored: sql`${prefix}is_boardsesh_authored`,
    controllerRouteUuid: sql`${prefix}controller_route_uuid`,
  })})`;
}

function legacyUnavailableQuantumClimbCondition(prefix: SQL = sql`board_climbs.`): SQL {
  return sql`(${prefix}board_type IS NOT DISTINCT FROM 'quantum' AND (
    ${prefix}layout_id NOT IN ${QUANTUM_RELEASED_LAYOUT_IDS} OR ${legacyRetiredQuantumCatalogClimbCondition(prefix)}
  ))`;
}

const LEGACY_RELEASED_LAYOUT_IDS = QUANTUM_RELEASED_LAYOUT_IDS.join(', ');
function legacySnapshotQuantumEligibility(prefix = ''): string {
  return `(${prefix}board_type <> 'quantum' OR (
    ${prefix}layout_id IN (${LEGACY_RELEASED_LAYOUT_IDS})
    AND ${prefix}is_listed IS TRUE AND ${prefix}controller_route_uuid IS NOT NULL
  ))`;
}

const dialect = new PgDialect();
const render = (fragment: SQL) => dialect.sqlToQuery(fragment);

// The aliases the call sites pass: the default, the sync select list, the sync
// reference EXISTS, the privacy reader and the beta-link reader.
const PREFIXES: Array<[string, SQL | undefined]> = [
  ['default', undefined],
  ['unqualified', sql``],
  ['bc.', sql`bc.`],
  ['privacy_reference_climb.', sql`privacy_reference_climb.`],
  ['privacy_beta_climb.', sql`privacy_beta_climb.`],
];

describe('rendered SQL against the helpers it replaced', () => {
  it('keeps the Quantum supplier-row predicate byte-identical', () => {
    expect(render(quantumCatalogClimbCondition())).toEqual(render(legacyQuantumCatalogClimbCondition()));
  });

  it.each(PREFIXES)('renders the withdrawn predicate as the retired one, board list aside (%s)', (_, prefix) => {
    const legacy = render(legacyRetiredQuantumCatalogClimbCondition(prefix));
    const generic = render(withdrawnCatalogClimbCondition(prefix));
    // The one textual change: a one-element IN list. Postgres parses
    // `x IN ('quantum')` to the same `x = 'quantum'` operator node, so the
    // planner and partial-index matching see the old expression.
    expect(generic.sql).toBe(legacy.sql.replace("board_type = 'quantum'", "board_type IN ('quantum')"));
    expect(generic.params).toEqual(legacy.params);
  });

  it.each(PREFIXES)('binds the same released layouts in the unavailable predicate (%s)', (_, prefix) => {
    expect(render(unavailableCatalogClimbCondition(prefix)).params).toEqual(
      render(legacyUnavailableQuantumClimbCondition(prefix)).params,
    );
  });
});

type ClimbShape = {
  id: number;
  board_type: string | null;
  layout_id: number | null;
  is_listed: boolean | null;
  user_id: string | null;
  is_boardsesh_authored: boolean | null;
  controller_route_uuid: string | null;
};

const RELEASED_LAYOUT_ID = QUANTUM_RELEASED_LAYOUT_IDS[0];
const UNRELEASED_LAYOUT_ID = 9105;

/**
 * Every row a `board_climbs` reference can present. `board_type`, `layout_id` and
 * `is_boardsesh_authored` are NOT NULL in the schema, so a real row never has
 * them NULL; the one all-NULL row is the empty side of an outer join, which is
 * how playlist counts read a member whose climb is gone.
 */
function climbShapes(): ClimbShape[] {
  const shapes: ClimbShape[] = [];
  for (const boardType of ['quantum', 'kilter', 'moonboard'])
    for (const layoutId of [RELEASED_LAYOUT_ID, UNRELEASED_LAYOUT_ID])
      for (const isListed of [true, false, null])
        for (const userId of [null, 'setter'])
          for (const isBoardseshAuthored of [true, false])
            for (const controllerRouteUuid of [null, 'route'])
              shapes.push({
                id: shapes.length,
                board_type: boardType,
                layout_id: layoutId,
                is_listed: isListed,
                user_id: userId,
                is_boardsesh_authored: isBoardseshAuthored,
                controller_route_uuid: controllerRouteUuid,
              });
  shapes.push({
    id: shapes.length,
    board_type: null,
    layout_id: null,
    is_listed: null,
    user_id: null,
    is_boardsesh_authored: null,
    controller_route_uuid: null,
  });
  return shapes;
}

/** Each predicate's three-valued answer per row, as 'true' / 'false' / null. */
async function evaluate(
  shapes: ClimbShape[],
  predicates: Record<string, SQL>,
): Promise<Array<Record<string, string | null>>> {
  const columns = Object.entries(predicates).map(
    ([label, predicate]) => sql`(${predicate})::text AS ${sql.identifier(label)}`,
  );
  return rowsFromResult<Record<string, string | null>>(
    await db.execute(sql`
      SELECT ${sql.join(columns, sql`, `)}
      FROM jsonb_to_recordset(${JSON.stringify(shapes)}::jsonb) AS board_climbs(
        id int, board_type text, layout_id int, is_listed boolean, user_id text,
        is_boardsesh_authored boolean, controller_route_uuid text
      )
      ORDER BY board_climbs.id
    `),
  );
}

describe('evaluated in Postgres against the helpers it replaced', () => {
  const shapes = climbShapes();

  it('answers every row as the retired and unavailable predicates did', async () => {
    const answers = await evaluate(shapes, {
      legacy_withdrawn: legacyRetiredQuantumCatalogClimbCondition(),
      withdrawn: withdrawnCatalogClimbCondition(),
      legacy_unavailable: legacyUnavailableQuantumClimbCondition(),
      unavailable: unavailableCatalogClimbCondition(),
      legacy_not_unavailable: sql`NOT ${legacyUnavailableQuantumClimbCondition()}`,
      not_unavailable: sql`NOT ${unavailableCatalogClimbCondition()}`,
    });
    expect(answers).toHaveLength(shapes.length);
    for (const answer of answers) {
      expect(answer.withdrawn).toBe(answer.legacy_withdrawn);
      expect(answer.unavailable).toBe(answer.legacy_unavailable);
      expect(answer.not_unavailable).toBe(answer.legacy_not_unavailable);
    }
    // Not vacuous: the grid reaches both answers of both predicates.
    expect(new Set(answers.map((answer) => answer.withdrawn))).toEqual(new Set(['true', 'false']));
    expect(new Set(answers.map((answer) => answer.unavailable))).toEqual(new Set(['true', 'false']));
  });

  it('answers every row as the snapshot exporters did', async () => {
    const answers = await evaluate(shapes, {
      legacy_eligible: sql.raw(legacySnapshotQuantumEligibility('board_climbs.')),
      eligible: sql.raw(snapshotCatalogEligibility('board_climbs.')),
    });
    for (const answer of answers) expect(answer.eligible).toBe(answer.legacy_eligible);
    expect(new Set(answers.map((answer) => answer.eligible))).toEqual(new Set(['true', 'false', null]));
  });

  it("answers the board gates as the `<> 'quantum'` they replaced, NULL included", async () => {
    // The smart-playlist tick gate and the snapshot-supplement term.
    const answers = await evaluate(shapes, {
      legacy_gate: sql`board_climbs.board_type <> 'quantum'`,
      availability_gate: sql`NOT (${unavailableCatalogClimbBoardCondition(sql`board_climbs.board_type`)})`,
      hiding_gate: sql`NOT (${hidesWithdrawnClimbsBoardCondition(sql`board_climbs.board_type`)})`,
    });
    for (const answer of answers) {
      expect(answer.availability_gate).toBe(answer.legacy_gate);
      expect(answer.hiding_gate).toBe(answer.legacy_gate);
    }
  });
});
