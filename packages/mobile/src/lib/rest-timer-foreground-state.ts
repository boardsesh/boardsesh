// Ephemeral foreground generation. Native AppState is observed by the mounted
// timer runtime; keeping this module pure also keeps tick saving renderer-free.
let active = true;
let generation = 0;
let controlGeneration = 0;
export function restTimerControlGeneration(): number {
  return controlGeneration;
}
export function sameRestTimerControlGeneration(snapshot: number): boolean {
  return snapshot === controlGeneration;
}
export function invalidateRestTimerControlIntent(): void {
  controlGeneration += 1;
}
export function setRestTimerForeground(activeNow: boolean): void {
  if (activeNow !== active) generation += 1;
  active = activeNow;
}
export function restTimerForegroundGeneration(): number | null {
  return active ? generation : null;
}
export function sameRestTimerForeground(snapshot: number | null): boolean {
  return snapshot !== null && active && snapshot === generation;
}

// Correlation only, never an authentication credential. Each process owns a
// unique namespace so subscription echoes can reject its old foreground events
// before the corresponding HTTP response arrives.
const acceptancePrefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-`;
let acceptanceSequence = 0;
export function createRestTimerAcceptanceId(): string | null {
  if (!active) return null;
  acceptanceSequence += 1;
  return `${acceptancePrefix}${generation}.${controlGeneration}-${acceptanceSequence}`;
}
export function canAdoptRestTimerAcceptance(acceptanceId: string | null | undefined): boolean {
  if (!acceptanceId?.startsWith(acceptancePrefix)) return true;
  return active && acceptanceId.startsWith(`${acceptancePrefix}${generation}.${controlGeneration}-`);
}
