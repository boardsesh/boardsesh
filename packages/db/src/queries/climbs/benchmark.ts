import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * True when a stats row's `benchmark_difficulty` marks a benchmark: a real
 * number above zero. Zero and NULL mean "not flagged".
 *
 * NaN needs its own test. Postgres ranks NaN above every number, so `> 0` alone
 * lets it through, and Kilter's feed holds tens of thousands of NaN rows
 * (#6232). The row mappers read NaN as no benchmark (`NaN > 0` is false in JS),
 * so a NaN row that passed `> 0` counted as a benchmark with no benchmark grade.
 *
 * The result is never NULL: a NULL input fails `IS NOT NULL` and the whole AND
 * is false. That keeps the condition safe under `NOT (...)`, where a NULL would
 * drop the row instead of keeping it.
 *
 * Both constants are SQL literals, not bound parameters. A bound NaN is not
 * portable across drivers (JSON turns it into null), and a literal 0 renders the
 * same text every time, so the condition can sit in a SELECT and its GROUP BY.
 */
export function realBenchmarkCondition(benchmarkDifficulty: SQLWrapper): SQL<boolean> {
  return sql<boolean>`(${benchmarkDifficulty} IS NOT NULL AND ${benchmarkDifficulty} > 0 AND ${benchmarkDifficulty} <> 'NaN'::double precision)`;
}
