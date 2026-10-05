import { LIST_MARKER, linesOutsideFences } from './sections';

/**
 * The on-device SQLite migration list. A PR that changes this file changes the
 * schema every phone migrates to on its next launch.
 */
export const OFFLINE_MIGRATIONS_PATH = 'packages/shared/offline-sync/src/db/migrations.ts';

/**
 * The line a PR body must carry, ticked, when the PR changes
 * OFFLINE_MIGRATIONS_PATH. Printed in the gate's error so an author can paste it.
 *
 * Why the gate exists: JS can go backwards on a device. A reverted canary OTA, or
 * a climber leaving the early-updates track, puts the previous bundle on a
 * database this PR's bundle already migrated. The app refuses a database whose
 * version is above what it knows (docs/offline-sync-plan.md, "Older JS on a
 * newer database"), so every such device loses offline storage until it updates
 * again. A migration is therefore written expand-first: the previous stable
 * bundle must still be able to read what it leaves behind, and anything that
 * breaks old readers (a drop, a rename, a tightened constraint) waits a release.
 */
export const OFFLINE_MIGRATION_ACK_LINE =
  '- [x] Offline DB: the previous stable bundle can read this schema (expand now, contract a release later)';

// A ticked task-list item naming the previous stable bundle and saying it can
// read the result. Loose on the surrounding words so the sentence can be edited
// for the PR at hand; strict on the three things that make it a statement: a
// tick, "previous stable", and "can read".
const TICKED_BOX = /^\[[xX]\]\s+/;
const NAMES_PREVIOUS_STABLE = /\bprevious\s+stable\b/i;
const SAYS_CAN_READ = /\bcan\s+(?:still\s+)?read\b/i;

/** True when `path` is the offline migration list. Tolerates a leading `./`. */
export function isOfflineMigrationsPath(path: string): boolean {
  return path.trim().replace(/^\.\//, '') === OFFLINE_MIGRATIONS_PATH;
}

/**
 * True when the body carries the ticked statement. An unticked box, a line
 * inside a code fence, and a line inside an HTML comment (where the PR template
 * keeps its copy) do not count.
 */
export function hasOfflineMigrationAck(body: string | null | undefined): boolean {
  if (!body) return false;
  return linesOutsideFences(body).some((line) => {
    const item = line.trim().replace(LIST_MARKER, '');
    return TICKED_BOX.test(item) && NAMES_PREVIOUS_STABLE.test(item) && SAYS_CAN_READ.test(item);
  });
}

/**
 * The gate: null when the PR may pass, otherwise the error to show. A PR that
 * does not touch the migration list is never asked for anything.
 */
export function findOfflineMigrationProblem(
  body: string | null | undefined,
  changedPaths: readonly string[],
): string | null {
  if (!changedPaths.some(isOfflineMigrationsPath)) return null;
  if (hasOfflineMigrationAck(body)) return null;
  return (
    `This PR changes ${OFFLINE_MIGRATIONS_PATH}. Older app JS can land on a phone this migration already ran on ` +
    '(a reverted canary update, or a climber leaving early updates), so the previous stable bundle must still be ' +
    'able to read the result: add columns, tables and indexes now, and drop or rename a release later. ' +
    `Confirm it by adding this line, ticked, to the description: "${OFFLINE_MIGRATION_ACK_LINE}"`
  );
}
