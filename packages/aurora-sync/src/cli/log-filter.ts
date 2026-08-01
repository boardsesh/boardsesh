import { SYNC_DAEMON_DISABLED_MESSAGE } from '@boardsesh/sync-runtime';

/** Fragments of runner log lines that non-verbose production runs still print. */
const OPERATOR_LOG_FRAGMENTS = [
  '✓',
  '✗',
  'Found',
  'Daemon',
  'Quiet hours',
  'Waiting',
  'No users',
  'Transient',
  // Ownership refusals are successful cycles, but operators need to see why
  // a user's circuits were omitted from the synced playlist list.
  'aurora_circuit_playlist_',
  'circuits not syncing',
  // Stuck-credential events and the hourly fleet summary remain visible.
  'CREDENTIAL',
  'Sync health',
  // A disabled daemon exits at once, so this line is the only record of why.
  SYNC_DAEMON_DISABLED_MESSAGE,
];

/** Whether a non-verbose CLI run prints this runner log line. */
export function isOperatorLogLine(message: string): boolean {
  return OPERATOR_LOG_FRAGMENTS.some((fragment) => message.includes(fragment));
}

/** Kept as a named Aurora-specific seam for the arbitration warning tests. */
export function shouldLogAuroraSyncMessage(message: string): boolean {
  return isOperatorLogLine(message);
}
