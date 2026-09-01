import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment files (same as migrate.ts)
config({ path: path.resolve(__dirname, '../../../.boardsesh/dev-db.env') });
config({ path: path.resolve(__dirname, '../../../.env.local') });
config({ path: path.resolve(__dirname, '../../web/.env.local') });
config({ path: path.resolve(__dirname, '../../web/.env.development.local') });

export function getScriptDatabaseUrl(): string {
  const databaseUrl = process.env.DB_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL, POSTGRES_URL, or DB_URL is not set');
    process.exit(1);
  }

  const isLocalUrl =
    databaseUrl.includes('localhost') || databaseUrl.includes('localtest.me') || databaseUrl.includes('127.0.0.1');

  // TODO(#4656): make this host-agnostic when the Vercel project goes away.
  // Widening it to "any automated build" is NOT the fix — .github/workflows/ci.yml
  // and db-migration-renumber.yml both run these scripts in GitHub Actions
  // against a localhost service container on purpose, so a CI term here would
  // exit(1) on every one of those jobs.
  if (process.env.VERCEL && isLocalUrl) {
    console.error('Refusing to run with local DATABASE_URL in Vercel build');
    process.exit(1);
  }

  return databaseUrl;
}

/**
 * Host:port to show a human, e.g. in "Importing to: <host>" log lines. Uses
 * `new URL()` rather than a naive `split('@')[1]?.split('/')[0]` — a
 * password or path containing `@`/`/` can throw that off, which matters here
 * because operators are meant to read this line and decide whether the
 * target looks right. Falls back to 'unknown' on an unparseable URL (matches
 * isLocalDatabaseUrl's fail-closed stance: never claim a host that wasn't
 * actually resolved).
 */
export function describeDatabaseHost(databaseUrl: string): string {
  try {
    return new URL(databaseUrl).host || 'unknown';
  } catch {
    return 'unknown';
  }
}

// `postgres` (the docker-compose service name — setup-development-db.sh's
// POSTGRES_HOST default) is a bare, single-label hostname with no TLD, so in
// principle a split-DNS/VPN setup could resolve it to something other than
// the local compose network. Accepted anyway: it's the actual, confirmed
// hostname this repo's own dev tooling produces (unlike an invented remote
// host, this isn't a guess), and nothing in Boardsesh's real infrastructure
// (Railway/Neon, reached by full public hostnames) is ever named `postgres`.
// 127.0.0.1 is covered by isLoopbackIpv4Address below (the whole 127.0.0.0/8
// block), so it's deliberately not repeated here.
const LOOPBACK_OR_COMPOSE_HOSTNAMES = new Set(['localhost', '::1', 'postgres']);

// NOTE ON "LOCAL": a Tailscale address/hostname is NOT local in the everyday
// sense — it's routed over the internet to a real machine. It counts as
// "local" HERE only because of what this file's callers use it for: telling
// apart a developer's own dev database from a real (prod/staging) one.
// scripts/dev-db-discover.ts's fallback path (used whenever local Docker isn't
// reachable — the normal case in a sandboxed/cloud dev environment, and the
// reason this matters at all) resolves DATABASE_URL to a Tailscale peer's
// MagicDNS name or CGNAT address when it can't find a Docker Postgres. That
// peer is still just the developer's own machine or a shared dev box, never
// Boardsesh's production or staging infrastructure (those are reached by
// public Railway/Neon hostnames, never Tailscale). So recognizing these two
// host shapes is what makes the guard compatible with that workflow instead of
// forcing every Tailscale-based dev setup through the manual remote-override
// env var on every run. Do NOT remove this without confirming
// scripts/dev-db-discover.ts no longer produces these host shapes.
//
// A plain decimal octet — no leading `+`/`-`, no scientific notation, no
// fractional part. Required before `Number(...)`: that coercion accepts
// "1e2" as 100, which would otherwise let e.g. "100.1e2.0.1" slip through as
// a CGNAT address.
const DECIMAL_OCTET = /^\d{1,3}$/;

// Parses a dotted-quad IPv4 hostname into four 0-255 octets, or null if it
// isn't one (wrong segment count, non-decimal segment per DECIMAL_OCTET, or a
// segment over 255). Shared by every IPv4-range check below so "what counts
// as a valid octet" can't drift between them.
function parseIpv4Octets(hostname: string): [number, number, number, number] | null {
  const segments = hostname.split('.');
  if (segments.length !== 4 || !segments.every((segment) => DECIMAL_OCTET.test(segment))) return null;
  const octets = segments.map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets as [number, number, number, number];
}

// The full IPv4 loopback block (RFC 1122 §3.2.1.3), not just 127.0.0.1: Linux
// commonly resolves the local hostname to 127.0.1.1, and any 127.x.x.x is
// loopback by definition.
function isLoopbackIpv4Address(hostname: string): boolean {
  const octets = parseIpv4Octets(hostname);
  return octets !== null && octets[0] === 127;
}

// Tailscale's CGNAT range (RFC 6598, carved out for Tailscale's own use):
// 100.64.0.0/10, i.e. first octet 100 and second octet 64-127 inclusive.
function isTailscaleCgnatAddress(hostname: string): boolean {
  const octets = parseIpv4Octets(hostname);
  if (octets === null) return false;
  const [first, second] = octets;
  return first === 100 && second >= 64 && second <= 127;
}

// Tailscale's MagicDNS domain. Match the whole final label, not a substring,
// so e.g. "evil-ts.net.attacker.example" can't slip through.
function isTailscaleMagicDnsHostname(hostname: string): boolean {
  return hostname === 'ts.net' || hostname.endsWith('.ts.net');
}

function isLocaltestMeHostname(hostname: string): boolean {
  return hostname === 'localtest.me' || hostname.endsWith('.localtest.me');
}

/**
 * True when `databaseUrl` resolves to a host that is unambiguously local or
 * dev-tooling infrastructure, never a real (prod/staging) database:
 *
 *  - The full IPv4 loopback block (`127.0.0.0/8`, not just `127.0.0.1` —
 *    Linux commonly resolves the local hostname to `127.0.1.1`), `::1`, or
 *    the `postgres` docker-compose service name (Dockerfile.dev-db and
 *    setup-development-db.sh always target one of these).
 *  - `*.localtest.me` (resolves to 127.0.0.1; used elsewhere in this repo for
 *    subdomain-aware local dev).
 *  - A Tailscale-reached dev box: MagicDNS (`*.ts.net`) or CGNAT
 *    (`100.64.0.0/10`) — see the NOTE ON "LOCAL" comment above for why these
 *    two, despite not being local in the everyday sense, belong in this list.
 *
 * Fails CLOSED: an unparseable URL is treated as non-local.
 */
export function isLocalDatabaseUrl(databaseUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Strip IPv6 brackets (URL#hostname keeps them, e.g. "[::1]").
  const normalizedHost = hostname.replace(/^\[|\]$/g, '');
  if (!normalizedHost) return false;

  return (
    LOOPBACK_OR_COMPOSE_HOSTNAMES.has(normalizedHost) ||
    isLoopbackIpv4Address(normalizedHost) ||
    isLocaltestMeHostname(normalizedHost) ||
    isTailscaleMagicDnsHostname(normalizedHost) ||
    isTailscaleCgnatAddress(normalizedHost)
  );
}

/**
 * One-shot database scripts may use plaintext only for the repo's known local
 * development hosts. Force TLS for remote URLs that omit it or permit
 * plaintext, while preserving URL modes that also verify certificates.
 */
export function scriptDatabaseConnectionOptions(databaseUrl: string) {
  const options = { max: 1 };
  if (isLocalDatabaseUrl(databaseUrl)) return options;

  try {
    const parsedDatabaseUrl = new URL(databaseUrl);
    const sslMode = parsedDatabaseUrl.searchParams.getAll('sslmode').at(-1);
    const sslRootCertificate = parsedDatabaseUrl.searchParams.getAll('sslrootcert').at(-1);
    const driverRequiresTls =
      sslRootCertificate === 'system' ||
      (sslMode !== undefined && !['', 'disable', 'false', 'allow', 'prefer'].includes(sslMode));
    if (driverRequiresTls) return options;
  } catch {
    // postgres-js will reject the URL. Keep the fail-safe TLS option so a
    // parse mismatch can never make a remote script choose plaintext.
  }

  return { ...options, ssl: 'require' as const };
}

type ScriptDb = ReturnType<typeof drizzle>;

export function createScriptDb(url?: string): { db: ScriptDb; close: () => Promise<void> } {
  const databaseUrl = url ?? getScriptDatabaseUrl();
  // Scripts are short-lived one-shots and target the direct (non-pooled) URL,
  // so a single connection is sufficient and avoids opening 10 by default.
  const client = postgres(databaseUrl, scriptDatabaseConnectionOptions(databaseUrl));
  const db = drizzle(client);
  return {
    db,
    close: async () => {
      await client.end();
    },
  };
}
