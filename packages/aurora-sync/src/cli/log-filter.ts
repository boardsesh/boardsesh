import { SYNC_DAEMON_DISABLED_MESSAGE } from '@boardsesh/sync-runtime';

/** Fragments of the runner log lines that non-verbose (production) runs still print. */
const OPERATOR_LOG_FRAGMENTS = [
  '✓',
  '✗',
  'Found',
  'Daemon',
  'Quiet hours',
  'Waiting',
  'No users',
  'Transient',
  // Stuck-credential observability events (see SyncRunner): CREDENTIAL
  // QUARANTINED / CREDENTIAL FLAPPING and the hourly "Sync health" fleet
  // summary must surface in non-verbose prod logs.
  'CREDENTIAL',
  'Sync health',
  // The daemon switch: a disabled daemon exits at once, so this line is the
  // only record of why it did.
  SYNC_DAEMON_DISABLED_MESSAGE,
];

/** Whether a non-verbose CLI run prints this runner log line. */
export function isOperatorLogLine(message: string): boolean {
  return OPERATOR_LOG_FRAGMENTS.some((fragment) => message.includes(fragment));
}
