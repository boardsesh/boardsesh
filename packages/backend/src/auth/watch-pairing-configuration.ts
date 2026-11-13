export type WatchPairingMode = 'legacy' | 'source-bound-staging';
export function watchPairingMode(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WatchPairingMode {
  const mode = environment.AUTH_WATCH_PAIRING_MODE;
  if (mode === undefined || mode === '' || mode === 'legacy') return 'legacy';
  if (mode !== 'source-bound-staging') throw new Error('Invalid watch pairing mode');
  return mode;
}

export function assertWatchPairingRevocationCompatibility(
  nativeMode: 'legacy' | 'generation',
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (nativeMode === 'generation' && watchPairingMode(environment) !== 'source-bound-staging')
    throw new Error('NATIVE_GENERATION_REQUIRES_SOURCE_BOUND_WATCH_PAIRING');
}
