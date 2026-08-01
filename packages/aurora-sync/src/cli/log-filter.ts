/** Messages that must remain visible when the Aurora CLI is not verbose. */
export function shouldLogAuroraSyncMessage(message: string): boolean {
  return (
    message.includes('✓') ||
    message.includes('✗') ||
    message.includes('Found') ||
    message.includes('Daemon') ||
    message.includes('Quiet hours') ||
    message.includes('Waiting') ||
    message.includes('No users') ||
    message.includes('Transient') ||
    // Circuit arbitration refusals are successful-cycle warnings, not thrown
    // errors. Keep both the per-circuit structured event and the credential
    // state summary visible in the default production logs.
    message.includes('aurora_circuit_playlist_') ||
    message.includes('circuits not syncing') ||
    // Stuck-credential observability events (see SyncRunner): CREDENTIAL
    // QUARANTINED / CREDENTIAL FLAPPING and the hourly fleet summary.
    message.includes('CREDENTIAL') ||
    message.includes('Sync health')
  );
}
