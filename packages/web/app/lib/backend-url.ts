/**
 * Runtime backend URL resolver.
 *
 * NEXT_PUBLIC_WS_URL is baked into the client bundle at build time by Next.js.
 * When a single deployment is served from multiple domains (e.g., branch
 * deploy previews at {N}.preview.boardsesh.com), the hard-coded value only
 * works for one access path.
 *
 * This module resolves the correct WebSocket URL at runtime by inspecting
 * the current hostname, so every access path reaches the right backend.
 *
 * Resolution order (client-side):
 * 1. Host-derived URL for preview domains ({N}.preview.boardsesh.com)
 * 2. NEXT_PUBLIC_WS_URL build-time fallback
 */

/**
 * Derive the WS backend URL from the current page hostname.
 *
 * Maps preview frontend hostnames to their corresponding backend:
 *   42.preview.boardsesh.com → wss://42.ws.preview.boardsesh.com/graphql
 *
 * Returns null when the hostname doesn't match a known pattern (callers
 * should fall back to the build-time env var).
 *
 * Exported for testing only.
 */
export function deriveWsUrlFromHost(hostname: string, secure: boolean): string | null {
  const protocol = secure ? 'wss' : 'ws';

  // Match {N}.preview.boardsesh.com → {N}.ws.preview.boardsesh.com
  const previewMatch = hostname.match(/^(\d+)\.preview\.boardsesh\.com$/);
  if (previewMatch) {
    return `${protocol}://${previewMatch[1]}.ws.preview.boardsesh.com/graphql`;
  }

  return null;
}

/**
 * Resolve the backend WebSocket URL at runtime.
 *
 * Safe to call in any context (SSR, client, module scope in 'use client'
 * files). On the server side it returns the build-time env var directly.
 */
export function getBackendWsUrl(): string | null {
  // Server-side: prefer internal URL for Docker networking, fall back to public URL
  if (typeof window === 'undefined') {
    return process.env.BACKEND_INTERNAL_URL || process.env.NEXT_PUBLIC_WS_URL || null;
  }

  // 1. Host-derived URL for known domain patterns
  const derived = deriveWsUrlFromHost(
    window.location.hostname,
    window.location.protocol === 'https:',
  );
  if (derived) return derived;

  // 2. Build-time fallback
  return process.env.NEXT_PUBLIC_WS_URL || null;
}

/**
 * Convert a WebSocket URL to its HTTP equivalent.
 *   ws://  → http://
 *   wss:// → https://
 */
export function getGraphQLHttpUrl(): string {
  const wsUrl = getBackendWsUrl();
  if (!wsUrl) {
    throw new Error(
      'Backend WebSocket URL could not be determined. ' +
        'Set NEXT_PUBLIC_WS_URL or access the app from a known domain.',
    );
  }
  return wsUrl.replace(/^ws(s?):\/\//, 'http$1://');
}

/**
 * Get the backend base HTTP URL (without /graphql path).
 * Useful for REST-style endpoints like avatar upload.
 */
export function getBackendHttpUrl(): string | null {
  const wsUrl = getBackendWsUrl();
  if (!wsUrl) return null;

  try {
    const url = new URL(wsUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}
