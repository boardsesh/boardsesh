import type { IncomingMessage, ServerResponse } from 'http';
import { execFileSync } from 'node:child_process';
import { logger } from '../utils/logger';

// Vercel preview deployment pattern: https://boardsesh-{hash}-marcodejonghs-projects.vercel.app
const VERCEL_PREVIEW_REGEX = /^https:\/\/boardsesh-[a-z0-9]+-marcodejonghs-projects\.vercel\.app$/;

// Homelab branch deploy pattern: https://{N}.preview.boardsesh.com
const PREVIEW_ORIGIN_REGEX = /^https:\/\/\d+\.preview\.boardsesh\.com$/;
const DEV_PRIVATE_LAN_ORIGIN_REGEX =
  /^http:\/\/(?:(?:10(?:\.\d{1,3}){3})|(?:192\.168(?:\.\d{1,3}){2})|(?:172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})):(?:300[0-9])$/;
// Match the dev orchestrator's findAvailablePort range — it auto-increments from 3000
// up to 3009 so multiple worktrees can run side-by-side. Anything in that window is a
// legitimate dev origin.
const DEV_WEB_PORTS = [3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009];
const TAILSCALE_STATUS_TIMEOUT_MS = 1500;

let allowedOrigins: string[] = [];
// In dev, any port on the host's Tailscale hostname is allowed so a worktree
// running on a non-default port (3005, 3010, …) doesn't get its requests
// blocked by CORS / WS origin checks.
let devTailscaleOriginRegex: RegExp | null = null;

function normalizeHostname(hostname: string): string | null {
  const trimmed = hostname.trim().replace(/\.$/, '');
  if (!trimmed) return null;

  // Hostnames only; disallow URLs, paths, and port suffixes.
  if (trimmed.includes('://') || trimmed.includes('/') || trimmed.includes(':')) {
    return null;
  }

  if (!/^[a-zA-Z0-9.-]+$/.test(trimmed)) {
    return null;
  }

  return trimmed.toLowerCase();
}

function resolveTailscaleHostname(): { hostname: string | null; reason: string } {
  const envHostnameRaw = process.env.TAILSCALE_HOSTNAME;
  if (envHostnameRaw !== undefined) {
    const normalizedEnvHostname = normalizeHostname(envHostnameRaw);
    if (normalizedEnvHostname) {
      return { hostname: normalizedEnvHostname, reason: 'using TAILSCALE_HOSTNAME' };
    }
    return { hostname: null, reason: 'TAILSCALE_HOSTNAME is invalid' };
  }

  try {
    const statusJson = execFileSync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      timeout: TAILSCALE_STATUS_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(statusJson) as { Self?: { DNSName?: string } };
    const dnsName = parsed.Self?.DNSName;

    if (!dnsName) {
      return { hostname: null, reason: 'tailscale status is missing Self.DNSName' };
    }

    const normalizedHostname = normalizeHostname(dnsName);
    if (!normalizedHostname) {
      return { hostname: null, reason: 'tailscale Self.DNSName is invalid' };
    }

    return { hostname: normalizedHostname, reason: 'using tailscale status' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { hostname: null, reason: 'tailscale CLI is not installed' };
    }
    return { hostname: null, reason: 'tailscale status is unavailable' };
  }
}

/**
 * Initialize CORS with allowed origins based on environment
 */
export function initCors(boardseshUrl: string): void {
  allowedOrigins = [boardseshUrl];

  // Also allow www subdomain variant
  try {
    const url = new URL(boardseshUrl);
    if (!url.hostname.startsWith('www.')) {
      allowedOrigins.push(`${url.protocol}//www.${url.hostname}`);
    }
  } catch {
    // Invalid URL, skip www variant
  }

  if (process.env.NODE_ENV !== 'production') {
    allowedOrigins.push('http://localhost:3000', 'http://127.0.0.1:3000');
    allowedOrigins.push('http://localhost:3001', 'http://127.0.0.1:3001'); // For multi-instance testing
    allowedOrigins.push('https://localhost:3000', 'https://127.0.0.1:3000');
    allowedOrigins.push('https://localhost:3001', 'https://127.0.0.1:3001');

    // Allow additional origins for LAN/mobile testing via DEV_ALLOWED_ORIGINS env var
    // Example: DEV_ALLOWED_ORIGINS=http://192.168.0.201:3000,http://192.168.1.100:3000
    const devAllowedOrigins = process.env.DEV_ALLOWED_ORIGINS;
    if (devAllowedOrigins) {
      devAllowedOrigins.split(',').forEach((origin) => {
        const trimmed = origin.trim();
        if (trimmed) {
          allowedOrigins.push(trimmed);
        }
      });
    }

    const tailscale = resolveTailscaleHostname();
    if (tailscale.hostname) {
      // Add both http:// and https:// variants — the dev orchestrator
      // provisions a Tailscale HTTPS cert when available, so phones hit the
      // dev server over https:// and their WebSocket upgrade origin is https
      // too. Dev-only, so allowing both schemes here is fine.
      DEV_WEB_PORTS.forEach((port) => {
        allowedOrigins.push(`http://${tailscale.hostname}:${port}`);
        allowedOrigins.push(`https://${tailscale.hostname}:${port}`);
      });
      // Allow ANY port on this Tailscale hostname so parallel worktree dev
      // servers on auto-incremented ports (3005, 3010, …) work without env tweaks.
      const escaped = tailscale.hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      devTailscaleOriginRegex = new RegExp(`^https?:\\/\\/${escaped}(?::\\d+)?$`);
      logger.info(`[CORS] Added Tailscale dev origins for ${tailscale.hostname} (${tailscale.reason})`);
    } else {
      devTailscaleOriginRegex = null;
      logger.info(`[CORS] Skipping Tailscale dev origins: ${tailscale.reason}`);
    }
  } else {
    devTailscaleOriginRegex = null;
  }

  allowedOrigins = [...new Set(allowedOrigins)];
}

/**
 * Check if an origin is allowed (includes Vercel preview deployments)
 */
export function isOriginAllowed(origin: string): boolean {
  if (allowedOrigins.includes(origin)) return true;
  if (VERCEL_PREVIEW_REGEX.test(origin)) return true;
  if (PREVIEW_ORIGIN_REGEX.test(origin)) return true;
  if (process.env.NODE_ENV !== 'production') {
    if (DEV_PRIVATE_LAN_ORIGIN_REGEX.test(origin)) return true;
    if (devTailscaleOriginRegex?.test(origin)) return true;
  }
  return false;
}

/**
 * Reduce a Host header or URL hostname to a bare, comparable hostname:
 * lowercase, no trailing dot, no surrounding IPv6 brackets, no port.
 * Bracket-aware so the colons inside an IPv6 literal aren't read as a port
 * separator.
 */
function normalizeHostForCompare(value: string): string {
  let host = value.trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) {
    // IPv6 literal: [::1] or [::1]:3000 — take what's between the brackets.
    const closing = host.indexOf(']');
    return closing === -1 ? '' : host.slice(1, closing);
  }
  const colon = host.indexOf(':');
  if (colon !== -1) host = host.slice(0, colon);
  return host;
}

/**
 * Allow a connection when its Origin is the same host it is connecting to.
 *
 * A genuine same-origin upgrade — the Origin's hostname equals the Host header
 * the client is connecting to — cannot be a cross-site WebSocket hijack: a
 * cross-site attacker's Origin is always their own domain, never our host. WS
 * auth here is token-based (`connectionParams.authToken`), not cookie-based, so
 * there is no ambient-credential surface to abuse either. This is strictly
 * narrower than the no-Origin branch the WS upgrade handler already allows.
 *
 * This is what lets the React Native Android app connect: RN derives the Origin
 * from the wss:// URL (https://ws.boardsesh.com), which equals the backend's own
 * host. It also covers preview WS hosts ({N}.ws.preview.boardsesh.com) with no
 * per-environment config, because the Railway/Cloudflare edge forwards the real
 * public host — the same value join.ts already trusts to build redirect URLs.
 *
 * Compares hostnames only (case-insensitive, trailing dot / port / IPv6 brackets
 * normalized away); scheme and port are intentionally not part of the
 * comparison. Fails closed on a missing Host header or an unparseable Origin.
 */
export function isSameOriginUpgrade(origin: string, host: string | undefined): boolean {
  if (!origin || !host) return false;
  let originHostname: string;
  try {
    originHostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  const normalizedOrigin = normalizeHostForCompare(originHostname);
  const normalizedHost = normalizeHostForCompare(host);
  return normalizedOrigin !== '' && normalizedOrigin === normalizedHost;
}

/**
 * Apply CORS headers to a response.
 * Returns false if this was an OPTIONS request and response was sent.
 * Returns true if processing should continue.
 */
export function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;

  if (origin && (isOriginAllowed(origin) || isSameOriginUpgrade(origin, req.headers.host))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  // Content-Encoding is needed for the PostHog batch endpoint — posthog-js
  // gzips the payload when CompressionStream is available, and the browser
  // lists "content-encoding" in the preflight's Access-Control-Request-Headers.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Encoding');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return false; // Signal that response was sent
  }

  return true; // Continue processing
}

/**
 * Get the list of allowed origins (for WebSocket verification)
 */
export function getAllowedOrigins(): string[] {
  return allowedOrigins;
}
