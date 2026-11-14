/** Static server-provided document configuration only. This never establishes
 * identity, and an absent/ambiguous registration never falls back to a URL. */
const registrations = new Map<symbol, string | null>();
export function registerCanonicalBrowserOrigin(origin?: string): () => void {
  let configured: string | null = null;
  try {
    if (origin) {
      const parsed = new URL(origin);
      if (parsed.protocol === 'https:' && parsed.origin === origin) configured = origin;
    }
  } catch {
    /* Invalid configuration remains unavailable. */
  }
  const owner = Symbol('canonical-browser-origin');
  registrations.set(owner, configured);
  return () => {
    registrations.delete(owner);
  };
}
export function getCanonicalBrowserOrigin(): string | null {
  const origins = [...registrations.values()];
  return origins.length && origins[0] !== null && origins.every((origin) => origin === origins[0]) ? origins[0] : null;
}
