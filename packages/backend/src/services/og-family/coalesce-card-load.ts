import type { LoadedOgFamilyCard } from './card-model';

/**
 * One load per card at a time. Facebook, Slack and WhatsApp each fetch a card
 * within the same moment; those land here, and share one gate and one render.
 * Nothing is kept once the load settles, so the next request runs its own gate.
 */
const cardLoadsInFlight = new Map<string, Promise<LoadedOgFamilyCard | null>>();

export function coalesceCardLoad(
  key: string,
  load: () => Promise<LoadedOgFamilyCard | null>,
): Promise<LoadedOgFamilyCard | null> {
  const running = cardLoadsInFlight.get(key);
  if (running) return running;
  const started = load().finally(() => {
    cardLoadsInFlight.delete(key);
  });
  cardLoadsInFlight.set(key, started);
  return started;
}

/** Test seam: process-lifetime map. */
export function resetCardLoadsInFlight(): void {
  cardLoadsInFlight.clear();
}
