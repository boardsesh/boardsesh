// Gym images are stored as the backend-relative path their upload endpoint
// returns (`/static/gym-logos/<uuid>.<ext>?v=...` for the kiosk logo,
// `/static/gym-photos/...` for the public-page photo). Storing the relative
// path keeps the database portable — no deploy domain frozen into user data —
// so EVERY render site must resolve it against the backend origin: in
// split-domain deploys (production web + backend on different hosts) the raw
// path would 404 against the frontend host. Absolute URLs (legacy or external)
// pass through untouched.
//
// Callers pass the base explicitly so this stays pure and testable:
//  - client components → getBackendHttpUrl()
//  - server components → getPublicBackendHttpUrl() (BROWSER-reachable origin,
//    never the Docker-internal one)

function resolveGymAssetDisplayUrl(storedUrl: string | null, backendHttpBaseUrl: string | null): string | null {
  if (!storedUrl) return null;
  // Protocol-relative (//host/...) is already absolute — only single-slash
  // backend paths get the origin prepended.
  if (!storedUrl.startsWith('/') || storedUrl.startsWith('//')) return storedUrl;
  if (!backendHttpBaseUrl) return storedUrl;
  return `${backendHttpBaseUrl.replace(/\/+$/, '')}${storedUrl}`;
}

/** Resolve `gyms.logo_url` (kiosk/embed brand mark) for rendering. */
export function resolveGymLogoDisplayUrl(logoUrl: string | null, backendHttpBaseUrl: string | null): string | null {
  return resolveGymAssetDisplayUrl(logoUrl, backendHttpBaseUrl);
}

/** Resolve `gyms.image_url` (the owner-uploaded gym photo) for rendering. */
export function resolveGymPhotoDisplayUrl(imageUrl: string | null, backendHttpBaseUrl: string | null): string | null {
  return resolveGymAssetDisplayUrl(imageUrl, backendHttpBaseUrl);
}
