import { createMemoryCollector } from './memory-collector';

export const MEMORY_PROFILING_ENABLED = process.env.EXPO_PUBLIC_PROFILE_MEMORY === '1';
export const memoryRunId = MEMORY_PROFILING_ENABLED ? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}` : '';
export const memoryProfile = createMemoryCollector(MEMORY_PROFILING_ENABLED, memoryRunId);
let nextOwner = 0;
export function memoryOwner(): string {
  return MEMORY_PROFILING_ENABLED ? `surface-${++nextOwner}` : '';
}

// One root-effect-owned wakeup so a cache-clear completion can export before
// iOS suspends timers. Released with the root effect; never stored in snapshots.
let exportWake: (() => void) | null = null;
export function registerMemoryExportWake(wake: () => void): () => void {
  exportWake = wake;
  return () => {
    if (exportWake === wake) exportWake = null;
  };
}
export function wakeMemoryExport(): void {
  exportWake?.();
}
