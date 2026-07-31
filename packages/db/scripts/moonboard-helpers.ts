import crypto from 'crypto';
import { sql, type SQL } from 'drizzle-orm';
import { boardClimbStats } from '../src/schema/boards/unified.js';

// =============================================================================
// Mapping constants
// =============================================================================

// Fixed namespace UUID for deterministic v5 UUID generation
export const MOONBOARD_UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // DNS namespace

// Hold state codes for frames encoding
export const HOLD_STATE_CODES = {
  start: 42,
  hand: 43,
  finish: 44,
};

// MoonBoard grid: 11 columns (A-K)
export const COLUMNS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
export const NUM_COLUMNS = 11;

// MoonBoard dump grade string -> shared difficulty ID.
// "5+" is MoonBoard's lowest grade and maps to the shared 5a/V1 bucket.
export const MOONBOARD_GRADE_TO_DIFFICULTY = {
  '5+': 13,
  '5A': 13,
  '5B': 14,
  '5C': 15,
  '6A': 16,
  '6A+': 17,
  '6B': 18,
  '6B+': 19,
  '6C': 20,
  '6C+': 21,
  '7A': 22,
  '7A+': 23,
  '7B': 24,
  '7B+': 25,
  '7C': 26,
  '7C+': 27,
  '8A': 28,
  '8A+': 29,
  '8B': 30,
  '8B+': 31,
  '8C': 32,
  '8C+': 33,
} as const;

// =============================================================================
// Types
// =============================================================================

export type MoonBoardMove = {
  // Present in the 2023 community dump, absent from the 2024 official export.
  // Never read by the helpers below, so it's optional.
  problemId?: number;
  description: string; // e.g., "J3", "E4"
  isStart: boolean;
  isEnd: boolean;
};

export function moonBoardGradeToDifficultyId(grade: string): number | undefined {
  const trimmedGrade = grade.trim();
  const normalizedGrade = trimmedGrade === '5+' ? trimmedGrade : trimmedGrade.toUpperCase();
  return MOONBOARD_GRADE_TO_DIFFICULTY[normalizedGrade as keyof typeof MOONBOARD_GRADE_TO_DIFFICULTY];
}

// =============================================================================
// Helper functions
// =============================================================================

/**
 * Generate deterministic UUID v5 from a string using a fixed namespace.
 */
export function uuidv5(name: string, namespace: string): string {
  // Parse namespace UUID into bytes
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');

  // Hash namespace + name with SHA-1
  const hash = crypto.createHash('sha1');
  hash.update(nsBytes);
  hash.update(name);
  const bytes = hash.digest();

  // Set version (5) and variant (RFC 4122)
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  // Format as UUID string
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Convert a grid coordinate (e.g., "J3") to a numeric hold ID.
 * ID = (row - 1) * 11 + colIndex + 1
 */
export function coordinateToHoldId(coord: string): number {
  const col = coord.charAt(0).toUpperCase();
  const row = parseInt(coord.slice(1), 10);
  const colIndex = COLUMNS.indexOf(col);
  if (colIndex === -1) throw new Error(`Invalid column in coordinate: ${coord}`);
  return (row - 1) * NUM_COLUMNS + colIndex + 1;
}

/**
 * Convert moves to frames string.
 * Format: p{holdId}r{roleCode}
 */
export function movesToFrames(moves: MoonBoardMove[]): string {
  return moves
    .map((move) => {
      const holdId = coordinateToHoldId(move.description);
      let role: number;
      if (move.isStart) {
        role = HOLD_STATE_CODES.start;
      } else if (move.isEnd) {
        role = HOLD_STATE_CODES.finish;
      } else {
        role = HOLD_STATE_CODES.hand;
      }
      return `p${holdId}r${role}`;
    })
    .join('');
}

/**
 * Get the hold state name for a move.
 */
export function moveToHoldState(move: MoonBoardMove): string {
  if (move.isStart) return 'STARTING';
  if (move.isEnd) return 'FINISH';
  return 'HAND';
}

/**
 * ON CONFLICT SET fragments for the three MoonBoard grade fields
 * (display/benchmark/average difficulty), shared by the two deprecated
 * single-file importers (import-moonboard-problems.ts, import-moonboard-2024.ts).
 *
 * Both scripts read a fixed historical snapshot (the 2023 community dump / a
 * 2024 no-grade export) that can be older than the current catalog import, so
 * a re-run must never let an incoming `excluded.*` value overwrite a newer
 * stored grade with a stale-or-absent one. COALESCE keeps whichever side is
 * non-null, preferring the incoming value only when it actually has one.
 * Unlike import-moonboard-catalog.ts (the authoritative, currently-maintained
 * source, where an incoming benchmark flag is trusted outright), these two
 * scripts are lower-trust snapshots, so all three fields are COALESCEd here,
 * including benchmarkDifficulty. See issue #3530.
 *
 * LIMITATION (by design, not an oversight): COALESCE only stops NULL from
 * clobbering a non-null value. It can't detect "this incoming value is a
 * non-null but stale grade from the frozen 2023/2024 dump" — a climb whose
 * grade genuinely changed since that dump would still take the old value on
 * a re-run. The two defenses in this fix are independent on purpose: the host
 * guard (moonboard-import-guard.ts) is what actually stops a re-run from
 * touching real data; this COALESCE only bounds the damage if that guard is
 * deliberately bypassed (MOONBOARD_IMPORT_ALLOW_REMOTE=1) or the target is a
 * restored copy that still has a legitimate reason to re-run these scripts.
 */
export function moonBoardGradeConflictFields(): {
  displayDifficulty: SQL;
  benchmarkDifficulty: SQL;
  difficultyAverage: SQL;
} {
  return {
    displayDifficulty: sql`coalesce(excluded.display_difficulty, ${boardClimbStats.displayDifficulty})`,
    benchmarkDifficulty: sql`coalesce(excluded.benchmark_difficulty, ${boardClimbStats.benchmarkDifficulty})`,
    difficultyAverage: sql`coalesce(excluded.difficulty_average, ${boardClimbStats.difficultyAverage})`,
  };
}
