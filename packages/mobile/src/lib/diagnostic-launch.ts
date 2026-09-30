import type { FeedbackDiagnosticsInput } from '@boardsesh/shared-schema';

/** Storage is injected so a locked keychain never prevents app startup. */
export function bootstrapDiagnosticLaunch(options: {
  readPrevious: () => string | null;
  writeCurrent: (serialized: string) => void;
  makeId: () => string;
  metadata: Partial<FeedbackDiagnosticsInput>;
}): FeedbackDiagnosticsInput {
  let launchId: string;
  try {
    launchId = options.makeId().slice(0, 200);
  } catch {
    launchId = `launch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  let previousLaunchId: string | null = null;
  try {
    const serialized = options.readPrevious();
    if (serialized && serialized.length <= 4096) {
      const previous: unknown = JSON.parse(serialized);
      if (previous !== null && typeof previous === 'object' && 'launchId' in previous) {
        const candidate = previous.launchId;
        if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 200)
          previousLaunchId = candidate;
      }
    }
  } catch {
    /* Prior launch correlation is optional. */
  }
  const launch: FeedbackDiagnosticsInput = {
    ...options.metadata,
    schemaVersion: 1,
    launchId,
    previousLaunchId,
  };
  try {
    options.writeCurrent(JSON.stringify({ launchId, nativeStartupId: options.metadata.nativeStartupId ?? null }));
  } catch {
    /* A failed diagnostics write never becomes an auth/storage error. */
  }
  return launch;
}

/** A crash result refers to the preceding native process, never an OTA reload. */
export function canAttributePreviousNativeCrash(
  serialized: string | null,
  currentStartupId: string | null | undefined,
  previousNativeStartupId: string | null | undefined,
): boolean {
  if (!serialized || serialized.length > 4096 || !currentStartupId || !previousNativeStartupId) return false;
  try {
    const previous: unknown = JSON.parse(serialized);
    if (!previous || typeof previous !== 'object' || !('nativeStartupId' in previous)) return false;
    return (
      typeof previous.nativeStartupId === 'string' &&
      previous.nativeStartupId.length > 0 &&
      previous.nativeStartupId !== currentStartupId &&
      previous.nativeStartupId === previousNativeStartupId
    );
  } catch {
    return false;
  }
}
