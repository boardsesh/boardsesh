// The pure half of the climb edit history (#5955): what a revision row says and
// which of the two board renderers draws it. No React and no native imports, so
// every decision here is tested without a renderer.

import type { ClimbRevisionRow } from '@boardsesh/graphql/operations/climb-revisions';
import { getCachedDateTimeFormat } from '../../lib/intl-formatter-cache';

/** Rows shown before "Show all". */
export const REVISIONS_INLINE_COUNT = 5;

/** The change kinds this build can name, in the order a row lists them. */
export const KNOWN_REVISION_CHANGES = ['name', 'description', 'holds', 'grade', 'angle', 'rules'] as const;
export type KnownRevisionChange = (typeof KNOWN_REVISION_CHANGES)[number];

/**
 * The changes a row can name, in a fixed order.
 *
 * `changes` is a loose string list on purpose: a newer server may add a kind
 * this build has no word for. Those are dropped rather than printed raw, and a
 * row left with none says "Edited".
 */
export function knownRevisionChanges(changes: readonly string[]): KnownRevisionChange[] {
  return KNOWN_REVISION_CHANGES.filter((change) => changes.includes(change));
}

/**
 * Whether there is a history worth a section.
 *
 * A climb nobody has edited has zero rows; the first edit writes two (the climb
 * as published, then the edit). One row cannot happen by the write rules, and if
 * it ever does it is a history with nothing to compare, so it is hidden too.
 */
export function hasRevisionHistory(rows: readonly ClimbRevisionRow[] | null | undefined): rows is ClimbRevisionRow[] {
  return Array.isArray(rows) && rows.length >= 2;
}

/**
 * How many times the climb has been edited.
 *
 * From the newest revision NUMBER, not the row count: numbers are never reused,
 * so a climb past the cap (oldest edits pruned) still reports every edit it has
 * had. Revision 1 is the climb as published, hence the minus one. Never below
 * what the rows themselves prove.
 */
export function revisionEditCount(rows: readonly ClimbRevisionRow[]): number {
  if (rows.length === 0) return 0;
  const newestNumber = rows.reduce((highest, row) => Math.max(highest, row.revisionNumber), 0);
  return Math.max(newestNumber - 1, rows.length - 1);
}

const REVISION_DATE_FORMAT: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };

/** A revision's date in the device locale. The raw string back if it will not parse. */
export function formatRevisionDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return getCachedDateTimeFormat(undefined, REVISION_DATE_FORMAT).format(date);
}

/**
 * How a revision's board gets drawn.
 *
 *  - `native`: the ordinary board image with the revision's frames. Every
 *    catalogue board (their holds never move), and a spray revision set on the
 *    wall version this session has registered.
 *  - `oldSprayVersion`: the revision was set on an EARLIER photo of the wall.
 *    The registered wall is the wrong picture and the wrong holds, so
 *    `SprayRevisionBoard` fetches that one version by itself, without touching
 *    the registry the live player draws from.
 *  - `unavailable`: a spray revision with no wall version on record. The sheet
 *    says so in one line and keeps the rest.
 */
export type RevisionBoardPath = 'native' | 'oldSprayVersion' | 'unavailable';

export function pickRevisionBoardPath(input: {
  boardName: string;
  /** `ClimbRevisionRow.sprayWallVersionNumber`. */
  revisionWallVersion: number | null;
  /** The version in the registry, or null when the wall is not registered. */
  registeredWallVersion: number | null;
}): RevisionBoardPath {
  if (input.boardName !== 'spray') return 'native';
  if (input.revisionWallVersion == null) return 'unavailable';
  // Not registered yet: the native path is the one that asks for the wall, and
  // this is decided again when it lands.
  if (input.registeredWallVersion == null) return 'native';
  return input.revisionWallVersion === input.registeredWallVersion ? 'native' : 'oldSprayVersion';
}
