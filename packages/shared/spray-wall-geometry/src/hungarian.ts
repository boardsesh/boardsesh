/**
 * Rectangular linear assignment — the Hungarian method, by shortest augmenting
 * paths (Jonker-Volgenant form), O(n^2 m).
 *
 * Implemented rather than depended on. The epic caps a wall at 1,500 holds, so
 * the worst case here is about 3.4 billion floating-point comparisons in theory
 * and a small fraction of that in practice (the potentials cut most rows short);
 * a real reset is tens to low hundreds of holds and finishes in milliseconds.
 * `munkres` and friends are small packages, but this has to run on a phone and in
 * the backend, and a shared package that pulls a dependency in pulls it into the
 * Metro graph and the mobile OTA fingerprint with it.
 *
 * ## Why a global assignment rather than greedy nearest
 *
 * Greedy nearest-neighbour matching is wrong in exactly the case resets produce:
 * a row of identical holds where one has been taken off. Greedy pairs each old
 * hold with the nearest new one, cascades the error along the row, and reports
 * the LAST hold as removed instead of the one that actually went. Minimising the
 * total instead gets the whole row right or the whole row wrong, and on real
 * geometry it gets it right.
 */

/** A cost this high means "these two are not a pair", not "an expensive pair". */
export const INFEASIBLE = 1e9;

export interface Assignment {
  /** `rowToColumn[row]` is the column it was assigned, or -1. */
  rowToColumn: number[];
  /** `columnToRow[column]` is the row it was assigned, or -1. */
  columnToRow: number[];
  /** Total cost of the assignment, infeasible pairs excluded. */
  cost: number;
}

/**
 * Minimum-cost assignment of rows to columns.
 *
 * Every row gets at most one column and vice versa. A pair whose cost is at or
 * above {@link INFEASIBLE} is never reported as assigned, which is how the gates
 * in `matchHolds` are expressed: the solver still has a well-defined dense
 * problem to work on (`Infinity` in a cost matrix makes the potentials NaN), and
 * the impossible pairs are dropped at the end.
 */
export function solveAssignment(cost: readonly (readonly number[])[]): Assignment {
  const rows = cost.length;
  const columns = rows > 0 ? cost[0].length : 0;
  const empty: Assignment = {
    rowToColumn: Array.from({ length: rows }, () => -1),
    columnToRow: Array.from({ length: columns }, () => -1),
    cost: 0,
  };
  if (rows === 0 || columns === 0) return empty;

  // The algorithm below needs rows <= columns; transpose and flip back if not.
  if (rows > columns) {
    const transposed: number[][] = Array.from({ length: columns }, (_, column) =>
      Array.from({ length: rows }, (_, row) => cost[row][column]),
    );
    const solved = solveAssignment(transposed);
    return { rowToColumn: solved.columnToRow, columnToRow: solved.rowToColumn, cost: solved.cost };
  }

  // One-based working arrays, which is what keeps the sentinel column 0 (the
  // "not yet matched" marker) out of the real index space.
  // Typed arrays rather than plain ones: at the epic's 1,500-hold cap these are
  // the hot inner loops, and they are pure numbers with a known length.
  const rowPotential = new Float64Array(rows + 1);
  const columnPotential = new Float64Array(columns + 1);
  const columnMatch = new Int32Array(columns + 1);
  const previousColumn = new Int32Array(columns + 1);

  for (let row = 1; row <= rows; row += 1) {
    columnMatch[0] = row;
    let column = 0;
    const minimum = new Float64Array(columns + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Uint8Array(columns + 1);

    do {
      used[column] = 1;
      const currentRow = columnMatch[column];
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;

      for (let candidate = 1; candidate <= columns; candidate += 1) {
        if (used[candidate] === 1) continue;
        const reduced = cost[currentRow - 1][candidate - 1] - rowPotential[currentRow] - columnPotential[candidate];
        if (reduced < minimum[candidate]) {
          minimum[candidate] = reduced;
          previousColumn[candidate] = column;
        }
        if (minimum[candidate] < delta) {
          delta = minimum[candidate];
          nextColumn = candidate;
        }
      }

      for (let candidate = 0; candidate <= columns; candidate += 1) {
        if (used[candidate] === 1) {
          rowPotential[columnMatch[candidate]] += delta;
          columnPotential[candidate] -= delta;
        } else {
          minimum[candidate] -= delta;
        }
      }
      column = nextColumn;
    } while (columnMatch[column] !== 0);

    // Walk the augmenting path back, flipping every edge on it.
    do {
      const previous = previousColumn[column];
      columnMatch[column] = columnMatch[previous];
      column = previous;
    } while (column !== 0);
  }

  const rowToColumn = Array.from({ length: rows }, () => -1);
  const columnToRow = Array.from({ length: columns }, () => -1);
  let total = 0;
  for (let column = 1; column <= columns; column += 1) {
    const row = columnMatch[column];
    if (row === 0) continue;
    const pairCost = cost[row - 1][column - 1];
    // A pair the gates already ruled out is a filler edge the solver needed to
    // keep the problem dense, not a match anyone asked for.
    if (pairCost >= INFEASIBLE) continue;
    rowToColumn[row - 1] = column - 1;
    columnToRow[column - 1] = row - 1;
    total += pairCost;
  }
  return { rowToColumn, columnToRow, cost: total };
}
