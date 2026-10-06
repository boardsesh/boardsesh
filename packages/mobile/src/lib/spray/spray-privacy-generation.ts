// A revoked session/wall must never publish a late download or native render.
// The launch nonce also prevents reusing private PNGs from a prior app session.
const launchNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
let sessionGeneration = 0;
let linkGeneration = 0;
const wallGenerations = new Map<number, number>();

/** Link identity is queried before its layout is known, so any withdrawal invalidates it. */
export function sprayLinkPrivacyGeneration(): string {
  return `${launchNonce}-${linkGeneration}`;
}

export function sprayPrivacyGeneration(layoutId?: number): string {
  return `${launchNonce}-${sessionGeneration}-${layoutId == null ? 0 : (wallGenerations.get(layoutId) ?? 0)}`;
}

/** Link adoption learns its layout only after await; retain each wall's epoch. */
export function captureSprayPrivacyGenerations(): (layoutId: number) => string {
  const session = sessionGeneration;
  const walls = new Map(wallGenerations);
  return (layoutId) => `${launchNonce}-${session}-${walls.get(layoutId) ?? 0}`;
}

/** Memory-cache identity; persisted editor drafts use a separate version-only token. */
export function sprayMemoryGeneration(layoutId: number): string {
  return `${sessionGeneration}-${wallGenerations.get(layoutId) ?? 0}`;
}

export function revokeSprayPrivacy(layoutId?: number): void {
  linkGeneration += 1;
  if (layoutId == null) {
    sessionGeneration += 1;
    wallGenerations.clear();
  } else {
    wallGenerations.set(layoutId, (wallGenerations.get(layoutId) ?? 0) + 1);
  }
}

/** Matches both old spray keys and generation-scoped keys, never catalogue art. */
export function sprayOverlayLayoutId(cacheKey: string): number | null {
  const match = /_spray_(\d+)_\d+_/.exec(cacheKey);
  return match ? Number(match[1]) : null;
}

export function isSprayOverlayCurrent(cacheKey: string): boolean {
  const layoutId = sprayOverlayLayoutId(cacheKey);
  return layoutId == null || cacheKey.endsWith(`_pg${sprayPrivacyGeneration(layoutId)}`);
}
