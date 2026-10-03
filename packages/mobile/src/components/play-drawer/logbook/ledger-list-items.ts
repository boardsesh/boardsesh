import type { LogbookEntry } from '@boardsesh/board-react';
import type { ClimbLedger, LedgerAngleSection, LedgerSession } from '@boardsesh/profile-stats';

/** One row of the full logbook list: an angle heading, or one day under it. */
export type LedgerListItem =
  | { kind: 'angle'; key: string; section: LedgerAngleSection<LogbookEntry> }
  | { kind: 'session'; key: string; session: LedgerSession<LogbookEntry>; angle: number };

/**
 * Flattens the ledger for a virtualised list: each angle heading followed by
 * every one of its sessions, in ledger order. No caps here; the list only
 * mounts what is on screen.
 */
export function buildLedgerListItems(ledger: ClimbLedger<LogbookEntry>): LedgerListItem[] {
  const items: LedgerListItem[] = [];
  for (const section of ledger.angles) {
    items.push({ kind: 'angle', key: `angle:${section.angle}`, section });
    for (const session of section.sessions) {
      items.push({ kind: 'session', key: `session:${section.angle}:${session.dayKey}`, session, angle: section.angle });
    }
  }
  return items;
}
